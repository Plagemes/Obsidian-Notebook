/**
 * Numerical analysis for function graphs (#113): roots, maxima and minima, intersections, derivatives (tangents) and
 * definite integrals (shaded areas), all by sampling then refining (bisection, golden-section search, adaptive
 * Simpson). Pure: no 'obsidian', no DOM.
 */

export type F1 = (x: number) => number;

export interface Extremum {
	x: number;
	y: number;
	kind: "max" | "min";
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;

/** Bisection on [a, b] where f changes sign; 80 halvings reach the precision of a double. */
function bisect(f: F1, a: number, b: number, fa: number): number {
	let lo = a, hi = b, flo = fa;
	for (let k = 0; k < 80; k++) {
		const m = (lo + hi) / 2;
		if (m === lo || m === hi) break;
		const fm = f(m);
		if (fm === 0) return m;
		if (Math.sign(fm) === Math.sign(flo)) {
			lo = m;
			flo = fm;
		} else hi = m;
	}
	return (lo + hi) / 2;
}

/** Minimum of g on [a, b] by golden-section search. */
function goldenMin(g: F1, a: number, b: number): number {
	let lo = a, hi = b;
	let x1 = hi - GOLDEN * (hi - lo), x2 = lo + GOLDEN * (hi - lo);
	let g1 = g(x1), g2 = g(x2);
	for (let k = 0; k < 100 && hi - lo > 1e-13 * Math.max(1, Math.abs(lo) + Math.abs(hi)); k++) {
		if (g1 < g2) {
			hi = x2;
			x2 = x1;
			g2 = g1;
			x1 = hi - GOLDEN * (hi - lo);
			g1 = g(x1);
		} else {
			lo = x1;
			x1 = x2;
			g1 = g2;
			x2 = lo + GOLDEN * (hi - lo);
			g2 = g(x2);
		}
	}
	return (lo + hi) / 2;
}

function samples(f: F1, a: number, b: number, n: number): { xs: Float64Array; ys: Float64Array } {
	const xs = new Float64Array(n + 1);
	const ys = new Float64Array(n + 1);
	for (let i = 0; i <= n; i++) {
		xs[i] = a + ((b - a) * i) / n;
		ys[i] = f(xs[i]!);
	}
	return { xs, ys };
}

/** Removes values closer than `eps` to the previous one (sorted input). */
function dedupe(xs: number[], eps: number): number[] {
	const out: number[] = [];
	for (const x of xs.sort((p, q) => p - q)) if (out.length === 0 || x - out[out.length - 1]! > eps) out.push(x);
	return out;
}

/**
 * Roots of f in [a, b]: sign changes refined by bisection (a sign change through a pole, where |f| does not go to 0,
 * is not a root), plus roots where f touches 0 without crossing (x² at 0), found as minima of |f|. At most `limit`.
 */
export function findRoots(f: F1, a: number, b: number, n = 600, limit = 50): number[] {
	if (!(b > a)) return [];
	const { xs, ys } = samples(f, a, b, n);
	const scale = Math.max(1e-300, ...Array.from(ys).filter(Number.isFinite).map(Math.abs));
	const found: number[] = [];
	const step = (b - a) / n;
	for (let i = 0; i < n && found.length < limit * 2; i++) {
		const y0 = ys[i]!, y1 = ys[i + 1]!;
		if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
		if (y0 === 0) {
			found.push(xs[i]!);
			continue;
		}
		if (Math.sign(y0) !== Math.sign(y1) && y1 !== 0) {
			const x = bisect(f, xs[i]!, xs[i + 1]!, y0);
			const fx = f(x);
			// Near a pole |f| grows instead of vanishing.
			if (Number.isFinite(fx) && Math.abs(fx) <= Math.min(Math.abs(y0), Math.abs(y1))) found.push(x);
		}
	}
	if (Number.isFinite(ys[n]!) && ys[n] === 0) found.push(xs[n]!);
	// Touching roots: a local minimum of |f| that is (numerically) zero.
	for (let i = 1; i < n; i++) {
		const a0 = Math.abs(ys[i - 1]!), a1 = Math.abs(ys[i]!), a2 = Math.abs(ys[i + 1]!);
		if (!(a1 <= a0 && a1 <= a2) || !Number.isFinite(a0 + a1 + a2)) continue;
		if (Math.sign(ys[i - 1]!) !== Math.sign(ys[i + 1]!)) continue;
		const x = goldenMin((t) => Math.abs(f(t)), xs[i - 1]!, xs[i + 1]!);
		if (Math.abs(f(x)) <= 1e-9 * scale) found.push(x);
	}
	return dedupe(found, step / 4).slice(0, limit);
}

/** Interior maxima and minima of f in [a, b] (not at the ends, not next to an undefined value). At most `limit`. */
export function findExtrema(f: F1, a: number, b: number, n = 600, limit = 50): Extremum[] {
	if (!(b > a)) return [];
	const { xs, ys } = samples(f, a, b, n);
	const out: Extremum[] = [];
	const step = (b - a) / n;
	for (let i = 1; i < n && out.length < limit; i++) {
		const y0 = ys[i - 1]!, y1 = ys[i]!, y2 = ys[i + 1]!;
		if (!Number.isFinite(y0) || !Number.isFinite(y1) || !Number.isFinite(y2)) continue;
		// Strict on both sides: a step (floor) or a flat stretch is not an extremum.
		const max = y1 > y0 && y1 > y2;
		const min = y1 < y0 && y1 < y2;
		if (!max && !min) continue;
		const x = goldenMin(max ? (t) => -f(t) : f, xs[i - 1]!, xs[i + 1]!);
		const y = f(x);
		if (!Number.isFinite(y)) continue;
		// A jump (floor) or a pole between samples is not an extremum: the refined value must stay near the samples.
		const spread = Math.abs(y0 - y1) + Math.abs(y2 - y1);
		if (Math.abs(y - y1) > spread + 1e-12 * Math.max(1, Math.abs(y1))) continue;
		if (out.length > 0 && Math.abs(out[out.length - 1]!.x - x) < step / 4) continue;
		out.push({ x, y, kind: max ? "max" : "min" });
	}
	return out;
}

/** x of the intersections of f and g in [a, b]. */
export function findIntersections(f: F1, g: F1, a: number, b: number, n = 600, limit = 50): number[] {
	return findRoots((x) => f(x) - g(x), a, b, n, limit);
}

/** Derivative at x by a fourth-order central difference. */
export function derivative(f: F1, x: number): number {
	const h = 1e-3 * Math.max(1, Math.abs(x));
	return (f(x - 2 * h) - 8 * f(x - h) + 8 * f(x + h) - f(x + 2 * h)) / (12 * h);
}

/** ∫ f over [a, b] by adaptive Simpson (NaN when f is undefined or the integral does not converge). */
export function integrate(f: F1, a: number, b: number, tolerance = 1e-10): number {
	if (a === b) return 0;
	if (a > b) return -integrate(f, b, a, tolerance);
	let evaluations = 0;
	const fx = (x: number) => {
		evaluations++;
		return f(x);
	};
	const simpson = (fa: number, fm: number, fb: number, w: number) => (w / 6) * (fa + 4 * fm + fb);
	const rec = (lo: number, hi: number, flo: number, fm: number, fhi: number, whole: number, tol: number, depth: number): number => {
		const m = (lo + hi) / 2;
		const lm = (lo + m) / 2, rm = (m + hi) / 2;
		const flm = fx(lm), frm = fx(rm);
		const left = simpson(flo, flm, fm, m - lo);
		const right = simpson(fm, frm, fhi, hi - m);
		const delta = left + right - whole;
		if (!Number.isFinite(delta)) return NaN;
		if (depth <= 0 || evaluations > 200_000 || Math.abs(delta) <= 15 * tol) return left + right + delta / 15;
		return rec(lo, m, flo, flm, fm, left, tol / 2, depth - 1) + rec(m, hi, fm, frm, fhi, right, tol / 2, depth - 1);
	};
	// Split into pieces first, so a narrow feature is not missed by the first Simpson estimate.
	const pieces = 16;
	let sum = 0;
	for (let k = 0; k < pieces; k++) {
		const lo = a + ((b - a) * k) / pieces;
		const hi = a + ((b - a) * (k + 1)) / pieces;
		const flo = fx(lo), fm = fx((lo + hi) / 2), fhi = fx(hi);
		if (!Number.isFinite(flo) || !Number.isFinite(fm) || !Number.isFinite(fhi)) return NaN;
		sum += rec(lo, hi, flo, fm, fhi, simpson(flo, fm, fhi, hi - lo), tolerance / pieces, 40);
	}
	return sum;
}
