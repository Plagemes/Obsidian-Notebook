/**
 * Drawn links (Z3): an arrow drawn with the shape tool from one card region to another links the two
 * cards. Pure: no 'obsidian'.
 *
 * The shape tool (and shape recognition) writes an arrow as one polyline: tail → tip, then tip → wing,
 * back to the tip, tip → wing (ink/shapes.ts `arrowPoints`). The tip is the point farthest from the tail
 * (the wings point back towards it), and the line must return to the tip after leaving it.
 */
import { regionContains, type Region } from "./subpath";

type Pt = readonly [number, number, ...number[]];

export interface ArrowEnds {
	tail: [number, number];
	tip: [number, number];
}

/** Tail and tip of an arrow stroke, or null when the points are not an arrow. */
export function arrowEnds(points: readonly Pt[]): ArrowEnds | null {
	if (points.length < 5) return null;
	const [tx, ty] = points[0]!;
	let tipIndex = 0;
	let best = -1;
	points.forEach((p, i) => {
		const d = Math.hypot(p[0] - tx, p[1] - ty);
		if (d > best) {
			best = d;
			tipIndex = i;
		}
	});
	const length = best;
	if (length < 10 || tipIndex === 0 || tipIndex >= points.length - 2) return null;
	const [px, py] = points[tipIndex]!;
	// Shaft: straight from the tail to the tip.
	for (let i = 1; i < tipIndex; i++) {
		const p = points[i]!;
		const cross = Math.abs((px - tx) * (ty - p[1]) - (tx - p[0]) * (py - ty)) / length;
		if (cross > Math.max(2, 0.08 * length)) return null;
	}
	// Head: leaves the tip, comes back to it, and leaves again (wings of length `wing`).
	let wing = 0;
	for (let i = tipIndex + 1; i < points.length; i++) wing = Math.max(wing, Math.hypot(points[i]![0] - px, points[i]![1] - py));
	if (wing < 3) return null;
	const near = Math.max(1, 0.25 * wing);
	let away = false;
	let back = false;
	let againAway = false;
	for (let i = tipIndex + 1; i < points.length; i++) {
		const d = Math.hypot(points[i]![0] - px, points[i]![1] - py);
		if (!away) away = d > 0.5 * wing;
		else if (!back) back = d <= near;
		else if (!againAway) againAway = d > 0.5 * wing;
	}
	if (!(away && back && againAway)) return null;
	return { tail: [tx, ty], tip: [px, py] };
}

export interface CardArea {
	key: string;
	/** Null: the whole page is the card. */
	region: Region | null;
}

/**
 * The card under a point: the smallest region containing it (grown by `tolerance`), else the
 * whole-page card if the page has one; null when there is neither.
 */
export function cardAt(x: number, y: number, cards: readonly CardArea[], tolerance = 6): string | null {
	let found: string | null = null;
	let area = Infinity;
	let page: string | null = null;
	for (const c of cards) {
		if (!c.region) {
			page ??= c.key;
			continue;
		}
		if (!regionContains(c.region, x, y, tolerance)) continue;
		const a = c.region.width * c.region.height;
		if (a < area) {
			area = a;
			found = c.key;
		}
	}
	return found ?? page;
}

/** The two cards an arrow joins (tail card → tip card); null when it does not start and end on two different cards. */
export function arrowLink(points: readonly Pt[], cards: readonly CardArea[], tolerance = 6): { from: string; to: string } | null {
	const ends = arrowEnds(points);
	if (!ends) return null;
	const from = cardAt(ends.tail[0], ends.tail[1], cards, tolerance);
	const to = cardAt(ends.tip[0], ends.tip[1], cards, tolerance);
	return from !== null && to !== null && from !== to ? { from, to } : null;
}
