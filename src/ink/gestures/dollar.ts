import { boundsOf, centroid, pathLength, resample, type Pt } from "./geometry";

/**
 * A small template matcher in the style of the $1 unistroke recogniser (Wobbrock, Wilson and Li, "Gestures without
 * Libraries, Toolkits or Training", UIST 2007; reference code New BSD licence, see docs/research.md). Original code: the
 * published algorithm is implemented from its description, nothing is copied.
 *
 * Differences from the paper, on purpose: the path is scaled uniformly (a straight line stays a line instead of becoming
 * a square) and is NOT rotated to an indicative angle (a user's "N" must not match their "Z"); instead the candidate is
 * compared at the best angle within a few degrees, found by golden-section search.
 */
export const TEMPLATE_POINTS = 48;
/** The rotation the matcher may undo to line a candidate up with a template. */
export const ANGLE_RANGE = (15 * Math.PI) / 180;
const ANGLE_PRECISION = (1.5 * Math.PI) / 180;
const PHI = 0.5 * (-1 + Math.sqrt(5));
/** Half the diagonal of the unit box: the distance that scores 0. */
const HALF_DIAGONAL = 0.5 * Math.SQRT2;

/** The path resampled, centred on its centroid and scaled so that its longer side is 1; null when it has no extent. */
export function normalise(pts: readonly Pt[]): Pt[] | null {
	if (pts.length < 2 || !(pathLength(pts) > 0)) return null;
	const r = resample(pts, TEMPLATE_POINTS);
	const c = centroid(r);
	const box = boundsOf(r);
	const size = Math.max(box.w, box.h);
	if (!(size > 0)) return null;
	return r.map((p) => ({ x: (p.x - c.x) / size, y: (p.y - c.y) / size }));
}

function meanDistance(a: readonly Pt[], b: readonly Pt[]): number {
	let d = 0;
	for (let i = 0; i < a.length; i++) d += Math.hypot(a[i]!.x - b[i]!.x, a[i]!.y - b[i]!.y);
	return d / a.length;
}

function rotated(pts: readonly Pt[], angle: number): Pt[] {
	const cos = Math.cos(angle), sin = Math.sin(angle);
	return pts.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
}

/** Smallest mean point distance between the candidate (rotated within `range`) and the template. */
export function distanceAtBestAngle(candidate: readonly Pt[], template: readonly Pt[], range = ANGLE_RANGE): number {
	let a = -range, b = range;
	let x1 = PHI * a + (1 - PHI) * b;
	let f1 = meanDistance(rotated(candidate, x1), template);
	let x2 = (1 - PHI) * a + PHI * b;
	let f2 = meanDistance(rotated(candidate, x2), template);
	while (Math.abs(b - a) > ANGLE_PRECISION) {
		if (f1 < f2) {
			b = x2;
			x2 = x1;
			f2 = f1;
			x1 = PHI * a + (1 - PHI) * b;
			f1 = meanDistance(rotated(candidate, x1), template);
		} else {
			a = x1;
			x1 = x2;
			f1 = f2;
			x2 = (1 - PHI) * a + PHI * b;
			f2 = meanDistance(rotated(candidate, x2), template);
		}
	}
	return Math.min(f1, f2);
}

/** 0..1 similarity of two normalised paths (1 = identical). */
export function similarity(candidate: readonly Pt[], template: readonly Pt[]): number {
	return Math.max(0, 1 - distanceAtBestAngle(candidate, template) / HALF_DIAGONAL);
}

export interface Template {
	name: string;
	points: readonly Pt[];
}

export interface TemplateMatch {
	name: string;
	score: number;
}

/** The best score per template name for a raw candidate path, best first. */
export function rankTemplates(candidate: readonly Pt[], templates: readonly Template[]): TemplateMatch[] {
	const c = normalise(candidate);
	if (!c) return [];
	const best = new Map<string, number>();
	for (const t of templates) {
		if (t.points.length !== TEMPLATE_POINTS) continue;
		const s = similarity(c, t.points);
		if (s > (best.get(t.name) ?? -1)) best.set(t.name, s);
	}
	return [...best].map(([name, score]) => ({ name, score })).sort((x, y) => y.score - x.score);
}
