/**
 * Plane geometry for the pen-gesture recognisers (roadmap 139). Pure: no DOM, no `obsidian`. Every function works
 * in CSS px of the screen (the scale of the hand), never in page units, so a gesture feels the same at any zoom.
 */
export interface Pt {
	x: number;
	y: number;
}

/** A sample of the gesture stroke: position (CSS px), time (ms) and pressure (0..1, optional). */
export interface TrailPoint extends Pt {
	t: number;
	p?: number;
}

export interface Box {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	w: number;
	h: number;
	diag: number;
}

export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

export function pathLength(pts: readonly Pt[]): number {
	let l = 0;
	for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1]!, pts[i]!);
	return l;
}

export function boundsOf(pts: readonly Pt[]): Box {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of pts) {
		if (p.x < minX) minX = p.x;
		if (p.x > maxX) maxX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.y > maxY) maxY = p.y;
	}
	if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0, diag: 0 };
	const w = maxX - minX, h = maxY - minY;
	return { minX, minY, maxX, maxY, w, h, diag: Math.hypot(w, h) };
}

export function centroid(pts: readonly Pt[]): Pt {
	let x = 0, y = 0;
	for (const p of pts) {
		x += p.x;
		y += p.y;
	}
	const n = Math.max(1, pts.length);
	return { x: x / n, y: y / n };
}

/** Drops points closer than `minStep` to the previously kept one (the last point is always kept). */
export function dedupe<T extends Pt>(pts: readonly T[], minStep: number): T[] {
	const out: T[] = [];
	for (const p of pts) {
		const last = out[out.length - 1];
		if (!last || dist(last, p) >= minStep) out.push(p);
	}
	const end = pts[pts.length - 1];
	if (end && out[out.length - 1] !== end) {
		if (out.length > 1 && dist(out[out.length - 1]!, end) < minStep) out[out.length - 1] = end;
		else out.push(end);
	}
	return out;
}

/** `n` points equally spaced along the path (the first and last point included). */
export function resample(pts: readonly Pt[], n: number): Pt[] {
	const first = pts[0];
	if (!first || n < 2) return first ? [{ x: first.x, y: first.y }] : [];
	const total = pathLength(pts);
	if (!(total > 0)) return Array.from({ length: n }, () => ({ x: first.x, y: first.y }));
	const step = total / (n - 1);
	const out: Pt[] = [{ x: first.x, y: first.y }];
	let carry = 0;
	for (let i = 1; i < pts.length && out.length < n; i++) {
		const a = pts[i - 1]!, b = pts[i]!;
		const seg = dist(a, b);
		if (!(seg > 0)) continue;
		let at = step - carry;
		while (at <= seg + 1e-9 && out.length < n) {
			const k = at / seg;
			out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
			at += step;
		}
		carry = seg - (at - step);
	}
	const last = pts[pts.length - 1]!;
	while (out.length < n) out.push({ x: last.x, y: last.y });
	out[n - 1] = { x: last.x, y: last.y };
	return out;
}

/** A 3-point moving average that keeps both ends (takes the hand tremor out before corners are looked for). */
export function smooth(pts: readonly Pt[], rounds = 1): Pt[] {
	let cur = pts.map((p) => ({ x: p.x, y: p.y }));
	for (let r = 0; r < rounds; r++) {
		if (cur.length < 3) return cur;
		const next = cur.map((p) => ({ x: p.x, y: p.y }));
		for (let i = 1; i < cur.length - 1; i++) {
			next[i] = { x: (cur[i - 1]!.x + cur[i]!.x + cur[i + 1]!.x) / 3, y: (cur[i - 1]!.y + cur[i]!.y + cur[i + 1]!.y) / 3 };
		}
		cur = next;
	}
	return cur;
}

function lineDistance(p: Pt, a: Pt, b: Pt): number {
	const dx = b.x - a.x, dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (!(len > 0)) return dist(p, a);
	return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Ramer-Douglas-Peucker: the corner points of the path (both ends included). */
export function simplify(pts: readonly Pt[], epsilon: number): Pt[] {
	if (pts.length < 3) return pts.map((p) => ({ x: p.x, y: p.y }));
	const keep = new Array<boolean>(pts.length).fill(false);
	keep[0] = keep[pts.length - 1] = true;
	const stack: Array<[number, number]> = [[0, pts.length - 1]];
	while (stack.length > 0) {
		const [lo, hi] = stack.pop()!;
		let worst = -1, at = -1;
		for (let i = lo + 1; i < hi; i++) {
			const d = lineDistance(pts[i]!, pts[lo]!, pts[hi]!);
			if (d > worst) {
				worst = d;
				at = i;
			}
		}
		if (worst > epsilon && at > 0) {
			keep[at] = true;
			stack.push([lo, at], [at, hi]);
		}
	}
	return pts.filter((_, i) => keep[i]).map((p) => ({ x: p.x, y: p.y }));
}

/** Signed change of direction at `b` going a → b → c, in radians (-π..π; positive turns clockwise on screen). */
export function turn(a: Pt, b: Pt, c: Pt): number {
	const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
	return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
}

/** Removes corners that make a leg shorter than `minLen` (a tick at the end of a line, a wobble in a corner). */
export function mergeShortLegs(verts: readonly Pt[], minLen: number): Pt[] {
	const v = verts.map((p) => ({ x: p.x, y: p.y }));
	for (;;) {
		if (v.length < 3) return v;
		let shortest = -1, len = Infinity;
		for (let i = 1; i < v.length; i++) {
			const l = dist(v[i - 1]!, v[i]!);
			if (l < len) {
				len = l;
				shortest = i;
			}
		}
		if (!(len < minLen)) return v;
		// Leg `shortest` runs from vertex shortest-1 to shortest. At the ends the inner vertex goes; inside, the one that bends less.
		if (shortest === 1) v.splice(1, 1);
		else if (shortest === v.length - 1) v.splice(v.length - 2, 1);
		else {
			const bendA = Math.abs(turn(v[shortest - 2]!, v[shortest - 1]!, v[shortest]!));
			const bendB = Math.abs(turn(v[shortest - 1]!, v[shortest]!, v[shortest + 1]!));
			v.splice(bendA <= bendB ? shortest - 1 : shortest, 1);
		}
	}
}

/** Direction of a → b, radians in (-π, π]. */
export const heading = (a: Pt, b: Pt): number => Math.atan2(b.y - a.y, b.x - a.x);

/** Smallest angle between two undirected lines of directions `a` and `b`, 0..π/2. */
export function lineAngle(a: number, b: number): number {
	let d = Math.abs(a - b) % Math.PI;
	if (d > Math.PI / 2) d = Math.PI - d;
	return d;
}

/** Do segments ab and cd cross? Each segment is lengthened by `slack` (a part of its own length) at both ends. */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt, slack = 0): boolean {
	const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
	const den = rx * sy - ry * sx;
	if (Math.abs(den) < 1e-9) return false;
	const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
	const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
	return t >= -slack && t <= 1 + slack && u >= -slack && u <= 1 + slack;
}

function segmentPointDistance(p: Pt, a: Pt, b: Pt): number {
	const dx = b.x - a.x, dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	if (!(len2 > 0)) return dist(p, a);
	const k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
	return Math.hypot(p.x - (a.x + dx * k), p.y - (a.y + dy * k));
}

/** Distance from `p` to the polyline. */
export function distanceToPath(p: Pt, path: readonly Pt[]): number {
	if (path.length === 1) return dist(p, path[0]!);
	let best = Infinity;
	for (let i = 1; i < path.length; i++) best = Math.min(best, segmentPointDistance(p, path[i - 1]!, path[i]!));
	return best;
}

/** Is the point inside the polygon (even-odd rule)? */
export function insidePolygon(p: Pt, poly: readonly Pt[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i]!, b = poly[j]!;
		if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
	}
	return inside;
}

/**
 * The corner points of a hand-drawn stroke: resample, smooth, simplify with a tolerance that follows the stroke's
 * size, and drop wobbles shorter than a part of it.
 */
export function corners(pts: readonly Pt[], epsilonShare = 0.05, minLegShare = 0.1): Pt[] {
	const box = boundsOf(pts);
	if (pts.length < 2 || !(box.diag > 0)) return pts.map((p) => ({ x: p.x, y: p.y }));
	const total = pathLength(pts);
	const path = smooth(resample(pts, Math.max(12, Math.min(96, Math.round(total / 4)))), 2);
	const verts = simplify(path, Math.max(3.5, box.diag * epsilonShare));
	return mergeShortLegs(verts, Math.max(10, total * minLegShare));
}
