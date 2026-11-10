import { fmt } from "./stats";

/**
 * The trend line of a line chart (0.30, roadmap #295): the least-squares line through the points of one series, x being the row position
 * (1, 2, 3 ...) because the rows of a line chart sit evenly spaced. Pure: it returns the fit, the dashes to draw and the label; the chart layout
 * places them. Rows with no number are left out of the fit.
 */

export interface TrendFit {
	/** Points used. */
	count: number;
	slope: number;
	intercept: number;
	/** Coefficient of determination; null when the values do not vary. */
	r2: number | null;
}

/** The least-squares line through the numbers of `values` against their row position (1-based); null with fewer than two numbers. */
export function fitTrend(values: ReadonlyArray<number | null>): TrendFit | null {
	const px: number[] = [];
	const py: number[] = [];
	values.forEach((v, i) => {
		if (v !== null && Number.isFinite(v)) {
			px.push(i + 1);
			py.push(v);
		}
	});
	const n = px.length;
	if (n < 2) return null;
	const mx = px.reduce((a, b) => a + b, 0) / n;
	const my = py.reduce((a, b) => a + b, 0) / n;
	let sxx = 0, syy = 0, sxy = 0;
	for (let i = 0; i < n; i++) {
		const dx = px[i]! - mx;
		const dy = py[i]! - my;
		sxx += dx * dx;
		syy += dy * dy;
		sxy += dx * dy;
	}
	if (sxx === 0) return null;
	const slope = sxy / sxx;
	return { count: n, slope, intercept: my - slope * mx, r2: syy === 0 ? null : Math.min(1, (sxy * sxy) / (sxx * syy)) };
}

/** The label of a trend: "y = 2.5x + 1  R² = 0.98" (R² left out when undefined). Short, for a small chart. */
export function trendLabel(fit: TrendFit): string {
	const m = fmt(fit.slope, 3);
	const b = fmt(Math.abs(fit.intercept), 3);
	const sign = fit.intercept < 0 && b !== "0" ? "−" : "+";
	const eq = b === "0" ? `y = ${m}x` : `y = ${m}x ${sign} ${b}`;
	return fit.r2 === null ? eq : `${eq}  R² = ${fmt(fit.r2, 2)}`;
}

export type Pt = readonly [number, number];

/**
 * The dashes of the line from `a` to `b` kept inside the horizontal band y in [top, bottom] (the plot area): pairs of points, each a short
 * piece. An empty list when the line misses the band.
 */
export function dashedSegment(a: Pt, b: Pt, top: number, bottom: number, dash = 6, gap = 4): Array<[Pt, Pt]> {
	const dy = b[1] - a[1];
	let t0 = 0, t1 = 1;
	if (dy === 0) {
		if (a[1] < top || a[1] > bottom) return [];
	} else {
		const ta = (top - a[1]) / dy;
		const tb = (bottom - a[1]) / dy;
		t0 = Math.max(t0, Math.min(ta, tb));
		t1 = Math.min(t1, Math.max(ta, tb));
	}
	if (!(t1 > t0)) return [];
	const at = (t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + dy * t];
	const p0 = at(t0);
	const p1 = at(t1);
	const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
	if (len < 1) return [];
	const out: Array<[Pt, Pt]> = [];
	for (let d = 0; d < len; d += dash + gap) {
		const e = Math.min(len, d + dash);
		const f0 = d / len, f1 = e / len;
		out.push([[p0[0] + (p1[0] - p0[0]) * f0, p0[1] + (p1[1] - p0[1]) * f0], [p0[0] + (p1[0] - p0[0]) * f1, p0[1] + (p1[1] - p0[1]) * f1]]);
	}
	return out;
}
