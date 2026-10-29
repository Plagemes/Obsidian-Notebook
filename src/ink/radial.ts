/**
 * Geometry of the radial menu (pure; the DOM part is in view/radial-menu.ts). Sector 0 is centred
 * on the top of the circle and the sectors follow clockwise.
 */
export interface RadialShape {
	/** Radius (CSS px) of the dead zone in the middle: no sector there. */
	inner: number;
	/** Radius (CSS px) of the outer edge of the ring. */
	outer: number;
	/** Number of sectors, at least 1. */
	count: number;
}

const TAU = Math.PI * 2;

/** Angle (rad, clockwise from the top) of the middle of sector `i`. */
export function sectorAngle(i: number, count: number): number {
	return (i / count) * TAU;
}

/** Position of the middle of sector `i` at distance `r` from the centre. */
export function sectorPoint(cx: number, cy: number, r: number, i: number, count: number): [number, number] {
	const a = sectorAngle(i, count);
	return [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
}

/** Index of the sector under (x, y) for a menu centred at (cx, cy), or -1 in the dead zone and outside the ring. */
export function sectorAt(shape: RadialShape, cx: number, cy: number, x: number, y: number): number {
	const { inner, outer, count } = shape;
	if (count < 1) return -1;
	const dx = x - cx;
	const dy = y - cy;
	const r = Math.hypot(dx, dy);
	if (!Number.isFinite(r) || r < inner || r > outer) return -1;
	// Clockwise angle from the top, shifted by half a sector so sector 0 is centred on the top.
	let a = Math.atan2(dx, -dy);
	if (a < 0) a += TAU;
	const step = TAU / count;
	return Math.floor((a + step / 2) / step) % count;
}

/** Centre for a menu opened at (x, y) in an area of `width` × `height`: moved inwards so the whole ring is visible. */
export function clampCenter(x: number, y: number, width: number, height: number, outer: number, margin = 8): [number, number] {
	const r = outer + margin;
	const clamp = (v: number, size: number) => (size < 2 * r ? size / 2 : Math.min(Math.max(v, r), size - r));
	return [clamp(x, width), clamp(y, height)];
}

/** SVG path of the annular sector `i` (a slice of the ring between `inner` and `outer`, with a small gap between slices). */
export function sectorPath(shape: RadialShape, cx: number, cy: number, i: number, gapPx = 2): string {
	const { inner, outer, count } = shape;
	const step = TAU / count;
	const mid = sectorAngle(i, count);
	if (count === 1) {
		const f = (n: number) => n.toFixed(2);
		return `M ${f(cx - outer)} ${f(cy)} A ${f(outer)} ${f(outer)} 0 1 0 ${f(cx + outer)} ${f(cy)} A ${f(outer)} ${f(outer)} 0 1 0 ${f(cx - outer)} ${f(cy)} `
			+ `M ${f(cx - inner)} ${f(cy)} A ${f(inner)} ${f(inner)} 0 1 1 ${f(cx + inner)} ${f(cy)} A ${f(inner)} ${f(inner)} 0 1 1 ${f(cx - inner)} ${f(cy)} Z`;
	}
	const pt = (r: number, a: number) => [cx + Math.sin(a) * r, cy - Math.cos(a) * r] as const;
	const gapOuter = gapPx / 2 / outer;
	const gapInner = gapPx / 2 / Math.max(1, inner);
	const [ox0, oy0] = pt(outer, mid - step / 2 + gapOuter);
	const [ox1, oy1] = pt(outer, mid + step / 2 - gapOuter);
	const [ix1, iy1] = pt(inner, mid + step / 2 - gapInner);
	const [ix0, iy0] = pt(inner, mid - step / 2 + gapInner);
	const large = step > Math.PI ? 1 : 0;
	const f = (n: number) => n.toFixed(2);
	return `M ${f(ox0)} ${f(oy0)} A ${f(outer)} ${f(outer)} 0 ${large} 1 ${f(ox1)} ${f(oy1)} `
		+ `L ${f(ix1)} ${f(iy1)} A ${f(inner)} ${f(inner)} 0 ${large} 0 ${f(ix0)} ${f(iy0)} Z`;
}

/** Most-recently-used colours: `color` first, no duplicates (case-insensitive), at most `max`. */
export function pushRecentColor(recent: readonly string[], color: string, max = 8): string[] {
	const c = color.toLowerCase();
	return [color, ...recent.filter((r) => r.toLowerCase() !== c)].slice(0, max);
}

/** `count` colours to offer: the recent ones first, topped up from `defaults`, without duplicates. */
export function recentColors(recent: readonly string[], defaults: readonly string[], count: number): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const c of [...recent, ...defaults]) {
		const k = c.toLowerCase();
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(c);
		if (out.length >= count) break;
	}
	return out;
}
