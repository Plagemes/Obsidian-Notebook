import {
	boundsOf, centroid, corners, dist, distanceToPath, heading, lineAngle, pathLength, resample, segmentsCross, smooth, turn,
	type Pt,
} from "./geometry";

/**
 * Rule-based recognisers for the built-in pen gestures (roadmap 139). All of them work on the stroke in CSS px.
 *
 * Philosophy (the same as shape recognition for "hold to straighten"): a missed gesture costs the user one more try, a
 * false one changes the page. Gestures only run while the user has explicitly entered gesture mode, but even then a
 * sloppy shape that is almost something else must match nothing, so every test of a recogniser has to pass.
 * `score` is 0..1 (1 = textbook shape); a result is only returned when every criterion holds.
 */
export interface ShapeMatch {
	score: number;
}

const clamp = (v: number, lo = 0, hi = 1): number => Math.max(lo, Math.min(hi, v));
const DEG = Math.PI / 180;

/** The shortest stroke any gesture is read from (CSS px of path). */
export const MIN_GESTURE_PATH_PX = 60;

export interface CircleMatch extends ShapeMatch {
	center: Pt;
	radius: number;
}

/**
 * A closed loop: 300°-500° of turning in one direction, a radius that stays within about a quarter of its mean, a
 * roughly round box and a start and end that meet (or overlap). Small loops (a handwritten "o") need a diameter of
 * at least 34 px, and whether anything is inside is the resolver's business.
 */
export function matchCircle(pts: readonly Pt[]): CircleMatch | null {
	const total = pathLength(pts);
	if (pts.length < 8 || total < 90) return null;
	const n = clamp(Math.round(total / 8), 16, 64);
	const path = smooth(resample(pts, n), 2);
	let sum = 0, mag = 0;
	for (let i = 1; i < path.length - 1; i++) {
		const t = turn(path[i - 1]!, path[i]!, path[i + 1]!);
		sum += t;
		mag += Math.abs(t);
	}
	const consistency = mag > 0 ? Math.abs(sum) / mag : 0;
	if (Math.abs(sum) < 5.4 || Math.abs(sum) > 8.7 || consistency < 0.8) return null;
	const center = centroid(path);
	let r = 0;
	for (const p of path) r += dist(p, center);
	r /= path.length;
	if (!(r * 2 >= 34)) return null;
	let sq = 0;
	for (const p of path) sq += (dist(p, center) - r) ** 2;
	const cv = Math.sqrt(sq / path.length) / r;
	if (cv > 0.27) return null;
	const box = boundsOf(path);
	if (Math.min(box.w, box.h) / Math.max(box.w, box.h) < 0.45) return null;
	// The end has to land on (or near) the beginning; an overshoot ends on the early part of the loop.
	const end = path[path.length - 1]!;
	let gap = Infinity;
	for (let i = 0; i <= Math.floor(path.length * 0.3); i++) gap = Math.min(gap, dist(end, path[i]!));
	if (gap > 0.8 * r) return null;
	const score = clamp(0.45 * (1 - cv / 0.27) + 0.3 * clamp((consistency - 0.8) / 0.2) + 0.25 * (1 - gap / (0.8 * r)));
	return { score: Math.max(0.05, score), center, radius: r };
}

export interface CaretMatch extends ShapeMatch {
	/** The tip of the caret. */
	apex: Pt;
}

/**
 * "^": two straight legs that meet in a tip at the top, 35°-125° apart, of similar length, and nothing else (a rounded
 * arch, an "n", an "A" or a "7" have more corners or a flat leg).
 */
export function matchCaret(pts: readonly Pt[]): CaretMatch | null {
	const total = pathLength(pts);
	if (pts.length < 4 || total < MIN_GESTURE_PATH_PX * 0.7) return null;
	const v = corners(pts, 0.06, 0.15);
	if (v.length !== 3) return null;
	const [s, a, e] = v as [Pt, Pt, Pt];
	const l1 = dist(s, a), l2 = dist(a, e);
	const shortest = Math.min(l1, l2);
	if (shortest < 20 || Math.max(l1, l2) / shortest > 2.4) return null;
	if (total > 1.25 * (l1 + l2)) return null;
	const rise1 = s.y - a.y, rise2 = e.y - a.y;
	if (rise1 < 0.35 * l1 || rise2 < 0.35 * l2) return null;
	const dx1 = s.x - a.x, dx2 = e.x - a.x;
	if (dx1 * dx2 >= 0 || Math.abs(dx1) < 0.15 * l1 || Math.abs(dx2) < 0.15 * l2) return null;
	const opening = Math.abs(turn(s, a, e));
	// The interior angle is π minus the turn at the tip.
	const interior = Math.PI - opening;
	if (interior < 35 * DEG || interior > 125 * DEG) return null;
	const score = clamp(1 - Math.abs(interior - 80 * DEG) / (60 * DEG)) * 0.6 + 0.4 * (shortest / Math.max(l1, l2));
	return { score: Math.max(0.05, score), apex: a };
}

export interface HashMatch extends ShapeMatch {
	center: Pt;
}

const VERT_SLACK = 30 * DEG;

/**
 * "#" drawn without lifting the pen: two roughly upright lines and two roughly level lines, every upright one
 * crossing every level one, spaced apart, in a box that is not a sliver. The strokes that join the four lines may be
 * slanted. Fewer or parallel-only lines (an "H", an "N", a zig-zag, a "+") never match.
 */
export function matchHash(pts: readonly Pt[]): HashMatch | null {
	const total = pathLength(pts);
	const box = boundsOf(pts);
	if (pts.length < 8 || total < 120 || box.diag < 60) return null;
	if (Math.min(box.w, box.h) / Math.max(box.w, box.h) < 0.45) return null;
	const v = corners(pts, 0.035, 0.04);
	const size = Math.max(box.w, box.h);
	const verticals: Array<[Pt, Pt]> = [];
	const levels: Array<[Pt, Pt]> = [];
	for (let i = 1; i < v.length; i++) {
		const a = v[i - 1]!, b = v[i]!;
		const len = dist(a, b);
		if (len < 28 || len < 0.4 * size) continue;
		const h = heading(a, b);
		if (lineAngle(h, Math.PI / 2) <= VERT_SLACK) verticals.push([a, b]);
		else if (lineAngle(h, 0) <= VERT_SLACK) levels.push([a, b]);
	}
	if (verticals.length < 2 || levels.length < 2) return null;
	const mid = (l: [Pt, Pt]): Pt => ({ x: (l[0].x + l[1].x) / 2, y: (l[0].y + l[1].y) / 2 });
	for (let i = 0; i < verticals.length; i++) {
		for (let j = i + 1; j < verticals.length; j++) {
			if (Math.abs(mid(verticals[i]!).x - mid(verticals[j]!).x) < 0.2 * box.w) continue;
			for (let k = 0; k < levels.length; k++) {
				for (let m = k + 1; m < levels.length; m++) {
					if (Math.abs(mid(levels[k]!).y - mid(levels[m]!).y) < 0.2 * box.h) continue;
					const all = [verticals[i]!, verticals[j]!].every((vl) => [levels[k]!, levels[m]!].every((hl) => segmentsCross(vl[0], vl[1], hl[0], hl[1], 0.25)));
					if (all) return { score: 0.8, center: { x: box.minX + box.w / 2, y: box.minY + box.h / 2 } };
				}
			}
		}
	}
	return null;
}

export interface StarMatch extends ShapeMatch {
	center: Pt;
}

/**
 * A five-pointed star drawn as one closed stroke (a pentagram: five long straight legs, a sharp turn of 105°-170° at
 * every corner, all the same way round, legs of similar length that cross each other, ending where it began).
 */
export function matchStar(pts: readonly Pt[]): StarMatch | null {
	const total = pathLength(pts);
	const box = boundsOf(pts);
	if (pts.length < 8 || total < 150 || box.diag < 60) return null;
	if (Math.min(box.w, box.h) / Math.max(box.w, box.h) < 0.6) return null;
	const v = corners(pts, 0.04, 0.08);
	if (v.length !== 6) return null;
	const legs = v.slice(1).map((p, i) => dist(v[i]!, p));
	const longest = Math.max(...legs), shortest = Math.min(...legs);
	if (shortest < 30 || longest / shortest > 2) return null;
	let sign = 0;
	for (let i = 1; i < v.length - 1; i++) {
		const t = turn(v[i - 1]!, v[i]!, v[i + 1]!);
		const m = Math.abs(t);
		if (m < 105 * DEG || m > 170 * DEG) return null;
		const s = Math.sign(t);
		if (sign !== 0 && s !== sign) return null;
		sign = s;
	}
	const mean = legs.reduce((a, b) => a + b, 0) / legs.length;
	const gap = dist(v[0]!, v[5]!);
	if (gap > 0.35 * mean) return null;
	let crossing = 0;
	for (const [i, j] of [[0, 2], [0, 3], [1, 3], [1, 4], [2, 4]] as const) {
		if (segmentsCross(v[i]!, v[i + 1]!, v[j]!, v[j + 1]!, 0.05)) crossing++;
	}
	if (crossing < 4) return null;
	return { score: clamp(0.6 + 0.4 * (1 - gap / (0.35 * mean))), center: centroid(v.slice(0, 5)) };
}

export interface LineMatch extends ShapeMatch {
	from: Pt;
	to: Pt;
}

/**
 * A straight stroke of at least 60 px, optionally with an arrow head or a tick at the end (a sharp turn back after the
 * long leg, shorter than a third of it). `to` is the tip. A curve, a corner in the middle or an out-and-back never matches.
 */
export function matchLine(pts: readonly Pt[]): LineMatch | null {
	const total = pathLength(pts);
	if (pts.length < 3 || total < MIN_GESTURE_PATH_PX) return null;
	const v = corners(pts, 0.06, 0.1);
	if (v.length === 2) return { score: 0.9, from: v[0]!, to: v[1]! };
	if (v.length > 4) return null;
	const first = dist(v[0]!, v[1]!);
	if (first < MIN_GESTURE_PATH_PX || first < 0.65 * total) return null;
	if (Math.abs(turn(v[0]!, v[1]!, v[2]!)) < 100 * DEG) return null;
	for (let i = 2; i < v.length; i++) if (dist(v[i - 1]!, v[i]!) > first / 3) return null;
	return { score: 0.75, from: v[0]!, to: v[1]! };
}

/**
 * Has the pen gone out along a straight line and come back along it to (about) where it began? That is "moving back along
 * the stroke": the user changed their mind, so the gesture is cancelled. Needs one turn-back only, so a scribble (many
 * turns) and a loop (which does not retrace itself) are not cancels.
 */
export function isRetrace(pts: readonly Pt[]): boolean {
	const total = pathLength(pts);
	if (pts.length < 6 || total < 80) return false;
	const start = pts[0]!;
	let far = 0, farDist = -1;
	for (let i = 0; i < pts.length; i++) {
		const d = dist(pts[i]!, start);
		if (d > farDist) {
			farDist = d;
			far = i;
		}
	}
	if (farDist < 40) return false;
	const out = pts.slice(0, far + 1), back = pts.slice(far);
	const l1 = pathLength(out), l2 = pathLength(back);
	if (l1 > 1.35 * farDist || l2 < 0.7 * l1 || l2 > 1.35 * l1 + 10) return false;
	const end = pts[pts.length - 1]!;
	if (dist(end, start) > Math.max(20, 0.3 * farDist)) return false;
	const tol = Math.max(10, 0.12 * farDist);
	for (const p of resample(back, 12)) if (distanceToPath(p, out) > tol) return false;
	return true;
}
