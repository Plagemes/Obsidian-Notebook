/**
 * Sampling of graphed functions (#113) into polylines in graph units: adaptive refinement where the curve bends or
 * jumps at the scale of the frame, breaks at discontinuities (poles of tan and 1/x, jumps of floor) and where the
 * function is undefined, clipping to a band around the viewport (no huge coordinates reach the canvas or the
 * exports), and implicit curves by marching squares. Pure: no 'obsidian', no DOM.
 */
import { contours, type Polyline, type Pt } from "./contour";

export type { Polyline, Pt } from "./contour";

export interface ViewRect {
	xMin: number;
	xMax: number;
	yMin: number;
	yMax: number;
}

export interface SampleOptions {
	/** Size of the frame on the page, pt: deviations are measured at this scale. */
	width: number;
	height: number;
	/** Initial uniform samples (default: one every 2 pt of width, at least 64). */
	base?: number;
	/** Deepest bisection of an initial interval (default 10). */
	maxDepth?: number;
	/** Largest deviation from a straight segment, pt (default 0.15). */
	tolerance?: number;
	/** Shared work limit (function evaluations); when it runs out the curve is finished with straight segments. */
	budget?: Budget;
}

/**
 * A limit on the number of function evaluations of a whole graph, so no expression (sin(99999x) twelve times) can
 * freeze the app: refinement stops when it is spent and `simplified` says the picture is coarser than asked.
 */
export interface Budget {
	left: number;
	simplified: boolean;
}

export function createBudget(evaluations: number): Budget {
	return { left: evaluations, simplified: false };
}

/** Largest number of initial samples of one curve. */
export const MAX_BASE_SAMPLES = 1024;
/** Largest grid side of an implicit curve, cells. */
export const MAX_IMPLICIT_SIDE = 400;

/** Cuts polylines to the rectangle [xMin, xMax] × [yMin, yMax] (Liang–Barsky per segment); a segment leaving it ends a polyline. */
export function clipPolylines(lines: readonly Polyline[], r: ViewRect): Polyline[] {
	const out: Polyline[] = [];
	for (const line of lines) {
		let cur: Pt[] = [];
		const flush = () => {
			if (cur.length > 1) out.push(cur);
			cur = [];
		};
		if (line.length === 1) {
			const [x, y] = line[0]!;
			if (x >= r.xMin && x <= r.xMax && y >= r.yMin && y <= r.yMax) out.push([[x, y]]);
			continue;
		}
		for (let i = 0; i + 1 < line.length; i++) {
			const [x0, y0] = line[i]!;
			const [x1, y1] = line[i + 1]!;
			const dx = x1 - x0;
			const dy = y1 - y0;
			let t0 = 0;
			let t1 = 1;
			let inside = true;
			for (const [p, q] of [[-dx, x0 - r.xMin], [dx, r.xMax - x0], [-dy, y0 - r.yMin], [dy, r.yMax - y0]] as const) {
				if (p === 0) {
					if (q < 0) inside = false;
				} else {
					const t = q / p;
					if (p < 0) {
						if (t > t1) inside = false;
						else if (t > t0) t0 = t;
					} else {
						if (t < t0) inside = false;
						else if (t < t1) t1 = t;
					}
				}
				if (!inside) break;
			}
			if (!inside) {
				flush();
				continue;
			}
			// The ends themselves when not cut, so consecutive segments share their point exactly.
			const a: Pt = t0 === 0 ? [x0, y0] : [x0 + t0 * dx, y0 + t0 * dy];
			const b: Pt = t1 === 1 ? [x1, y1] : [x0 + t1 * dx, y0 + t1 * dy];
			const last = cur[cur.length - 1];
			if (!last || t0 > 0 || last[0] !== a[0] || last[1] !== a[1]) {
				flush();
				cur.push(a);
			}
			cur.push(b);
			if (t1 < 1) flush();
		}
		flush();
	}
	return out;
}

/** The band the samplers clip to: the view plus one view size on every side (lines leaving the frame stay straight). */
function band(v: ViewRect): ViewRect {
	const w = v.xMax - v.xMin;
	const h = v.yMax - v.yMin;
	return { xMin: v.xMin - w, xMax: v.xMax + w, yMin: v.yMin - h, yMax: v.yMax + h };
}

/**
 * A curve t → (x(t), y(t)) over [t0, t1], refined adaptively. `toFrame` maps graph units to frame pt (used for
 * tolerances only). Undefined values and jumps break the curve.
 */
function sampleCurve(
	at: (t: number) => Pt, t0: number, t1: number, view: ViewRect, o: SampleOptions,
): Polyline[] {
	const sx = o.width / (view.xMax - view.xMin);
	const sy = o.height / (view.yMax - view.yMin);
	const base = Math.min(MAX_BASE_SAMPLES, Math.max(8, Math.round(o.base ?? Math.max(64, o.width / 2))));
	const maxDepth = o.maxDepth ?? 10;
	const budget = o.budget;
	// One evaluation, counted against the budget.
	const eval1 = (t: number): Pt => {
		if (budget) budget.left--;
		return at(t);
	};
	const spent = () => {
		if (!budget || budget.left > 0) return false;
		budget.simplified = true;
		return true;
	};
	const tol = o.tolerance ?? 0.15;
	const jumpPt = Math.max(o.height, o.width) * 0.5;
	const finite = (p: Pt) => Number.isFinite(p[0]) && Number.isFinite(p[1]);
	const lines: Polyline[] = [];
	let cur: Pt[] = [];
	const breakLine = () => {
		if (cur.length > 0) lines.push(cur);
		cur = [];
	};
	const emit = (p: Pt) => {
		if (!finite(p)) {
			breakLine();
			return;
		}
		const last = cur[cur.length - 1];
		if (!last || last[0] !== p[0] || last[1] !== p[1]) cur.push(p);
	};
	// Distance in pt between two graph points.
	const dist = (a: Pt, b: Pt) => Math.hypot((a[0] - b[0]) * sx, (a[1] - b[1]) * sy);
	const refine = (ta: number, pa: Pt, tb: number, pb: Pt, depth: number): void => {
		if (spent()) {
			emit(pb);
			return;
		}
		const tm = (ta + tb) / 2;
		const pm = eval1(tm);
		const fa = finite(pa), fb = finite(pb), fm = finite(pm);
		if (!fa && !fb && !fm) {
			// Undefined across the interval (sqrt of a negative, log of a negative): nothing to refine.
			breakLine();
			return;
		}
		if (!fa || !fb || !fm) {
			if (depth < maxDepth) {
				refine(ta, pa, tm, pm, depth + 1);
				refine(tm, pm, tb, pb, depth + 1);
			} else {
				// Undefined somewhere in a tiny interval: end the curve at the last defined point.
				if (fa && !fb) emit(pa);
				breakLine();
				if (fb) emit(pb);
			}
			return;
		}
		// Deviation of the midpoint from the chord, in pt.
		const cx = (pa[0] + pb[0]) / 2, cy = (pa[1] + pb[1]) / 2;
		const dev = Math.hypot((pm[0] - cx) * sx, (pm[1] - cy) * sy);
		const chord = dist(pa, pb);
		if ((dev > tol || chord > jumpPt * 0.25) && depth < maxDepth) {
			refine(ta, pa, tm, pm, depth + 1);
			refine(tm, pm, tb, pb, depth + 1);
			return;
		}
		if (depth >= maxDepth && chord > 2) {
			// Still a large step at the finest scale: a jump unless the change is spread over both halves (steep but continuous).
			const d1 = dist(pa, pm), d2 = dist(pm, pb);
			const ratio = Math.min(d1, d2) / Math.max(d1, d2, 1e-300);
			if (ratio < 0.1 || chord > jumpPt) {
				emit(pa);
				breakLine();
				emit(pb);
				return;
			}
		}
		emit(pb);
	};
	let ta = t0;
	let pa = eval1(ta);
	emit(pa);
	// With the budget spent, the remaining initial samples are thinned out (the curve stays whole, coarser).
	for (let k = 1; k <= base; k++) {
		if (spent() && k < base && k % 16 !== 0) continue;
		const tb = t0 + ((t1 - t0) * k) / base;
		const pb = eval1(tb);
		refine(ta, pa, tb, pb, 0);
		ta = tb;
		pa = pb;
	}
	breakLine();
	return clipPolylines(lines, band(view));
}

/** y = f(x) over the view (or over [from, to] ∩ view when given). */
export function sampleFunction(f: (x: number) => number, view: ViewRect, o: SampleOptions, from = view.xMin, to = view.xMax): Polyline[] {
	const a = Math.max(from, view.xMin);
	const b = Math.min(to, view.xMax);
	if (!(b > a)) return [];
	return sampleCurve((x) => [x, f(x)], a, b, view, { ...o, base: Math.min(MAX_BASE_SAMPLES, Math.max(8, Math.round((o.base ?? Math.max(64, o.width / 2)) * (b - a) / (view.xMax - view.xMin)))) });
}

/** (x(t), y(t)) for t in [t0, t1]. */
export function sampleParametric(x: (t: number) => number, y: (t: number) => number, t0: number, t1: number, view: ViewRect, o: SampleOptions): Polyline[] {
	if (!(t1 > t0)) return [];
	return sampleCurve((t) => [x(t), y(t)], t0, t1, view, { ...o, base: o.base ?? 400 });
}

/** r = f(θ) for θ in [t0, t1] (radians, or degrees with `degrees`). */
export function samplePolar(r: (theta: number) => number, t0: number, t1: number, view: ViewRect, o: SampleOptions, degrees = false): Polyline[] {
	const k = degrees ? Math.PI / 180 : 1;
	return sampleParametric((t) => r(t) * Math.cos(t * k), (t) => r(t) * Math.sin(t * k), t0, t1, view, o);
}

/**
 * F(x, y) = 0 over the view by marching squares on a grid of about `cells` cells (square cells in frame space).
 * A sign change through a pole (|F| at the segment's midpoint larger than at the cell's corners) is not a curve.
 */
export function sampleImplicit(F: (x: number, y: number) => number, view: ViewRect, o: SampleOptions, cells = 160 * 110): Polyline[] {
	const budget = o.budget;
	// The grid uses at most half of what is left of the budget (the midpoint checks need some more), at least 64 cells.
	if (budget) {
		const room = Math.max(64, Math.floor(budget.left / 2));
		if (room < cells) {
			cells = room;
			budget.simplified = true;
		}
	}
	const aspect = Math.min(50, Math.max(1 / 50, o.width / o.height));
	const ny = Math.min(MAX_IMPLICIT_SIDE, Math.max(8, Math.round(Math.sqrt(cells / aspect))));
	const nx = Math.min(MAX_IMPLICIT_SIDE, Math.max(8, Math.round(ny * aspect)));
	if (budget) budget.left -= (nx + 1) * (ny + 1);
	const gx = (i: number) => view.xMin + ((view.xMax - view.xMin) * i) / nx;
	const gy = (j: number) => view.yMin + ((view.yMax - view.yMin) * j) / ny;
	const values = new Float64Array((nx + 1) * (ny + 1));
	for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) values[j * (nx + 1) + i] = F(gx(i), gy(j));
	const lines = contours({ nx: nx + 1, ny: ny + 1, values }, 0, (i, j, a, b) => {
		const corners = [values[j * (nx + 1) + i]!, values[j * (nx + 1) + i + 1]!, values[(j + 1) * (nx + 1) + i]!, values[(j + 1) * (nx + 1) + i + 1]!];
		if (budget) budget.left--;
		const m = F(gx((a[0] + b[0]) / 2), gy((a[1] + b[1]) / 2));
		return Number.isFinite(m) && Math.abs(m) <= Math.max(...corners.map(Math.abs));
	});
	return lines.map((l) => l.map(([i, j]): Pt => [gx(i), gy(j)]));
}
