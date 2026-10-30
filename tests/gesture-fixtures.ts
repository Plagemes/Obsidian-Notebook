import { arc, GLYPHS, poly } from "../src/ink/gestures/glyphs";
import type { GestureWorld } from "../src/ink/gestures/resolve";
import type { Pt, TrailPoint } from "../src/ink/gestures/geometry";

/** Deterministic pseudo-random numbers in [0, 1). */
export function rng(seed: number): () => number {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 4294967296;
	};
}

/** Places a unit-ish path on the screen: scaled by `size`, moved to (x, y), with hand tremor and an optional slant. */
export function draw(path: readonly Pt[], opts: { x?: number; y?: number; size?: number; jitter?: number; seed?: number; rotate?: number; sx?: number; sy?: number } = {}): TrailPoint[] {
	const { x = 200, y = 200, size = 60, jitter = 0, seed = 7, rotate = 0, sx = 1, sy = 1 } = opts;
	const rand = rng(seed);
	const cos = Math.cos(rotate), sin = Math.sin(rotate);
	return path.map((p, i) => {
		const px = p.x * sx * size, py = p.y * sy * size;
		return {
			x: x + px * cos - py * sin + (rand() - 0.5) * 2 * jitter,
			y: y + px * sin + py * cos + (rand() - 0.5) * 2 * jitter,
			t: i * 8,
		};
	});
}

/** A stroke written in `ms` milliseconds in total. */
export function inMs(trail: TrailPoint[], ms: number): TrailPoint[] {
	return trail.map((p, i) => ({ ...p, t: (i * ms) / Math.max(1, trail.length - 1) }));
}

/** A world with a page everywhere, no selection and nothing to select or delete unless told otherwise. */
export function world(over: Partial<GestureWorld> = {}): GestureWorld {
	return {
		enclosedInk: () => 0,
		scribbleVictims: () => 0,
		onPage: () => true,
		onSelection: () => false,
		thumbnailAt: () => -1,
		selectionPage: () => -1,
		...over,
	};
}

const q = (corners: Array<[number, number]>, n = 10): Pt[] => poly(corners, n);

/** Shapes of the built-in gestures, y down, about one unit in size. */
export const SHAPES = {
	circle: (): Pt[] => arc(0, 0, 1, -100, 270, 48),
	circleOvershoot: (): Pt[] => arc(0, 0, 1, -100, 330, 52),
	caret: (): Pt[] => q([[0, 1.2], [0.7, 0], [1.4, 1.2]], 14),
	hash: (): Pt[] => q([[1, 0], [1.1, 3], [2, 0], [2.1, 3], [0, 2], [3, 2], [3, 1], [0, 1]], 14),
	star: (): Pt[] => {
		const pt = (k: number): [number, number] => [Math.cos(((-90 + k * 72) * Math.PI) / 180), Math.sin(((-90 + k * 72) * Math.PI) / 180)];
		const order = [0, 2, 4, 1, 3, 0];
		return q(order.map(pt), 14);
	},
	question: (): Pt[] => GLYPHS["?"]!(),
	questionOpen: (): Pt[] => GLYPHS["?-open"]!(),
	line: (): Pt[] => q([[0, 0], [3, -2]], 24),
	arrow: (): Pt[] => q([[0, 0], [3, -2], [2.3, -1.9]], 12),
	scribble: (): Pt[] => q([[0, 0], [2, 0.2], [0, 0.5], [2, 0.7], [0, 1], [2, 1.2], [0, 1.5]], 8),
};

/** Handwriting stand-ins for the negative tests. */
export const WRITING: Record<string, () => Pt[]> = {
	...Object.fromEntries(["2", "3", "5", "7", "9", "S", "J", "6"].map((k) => [k, GLYPHS[k]!])),
	"1": () => q([[0, 0.5], [0.6, 0], [0.6, 3]], 12),
	"4": () => q([[1, 0], [0, 2], [2, 2], [1.5, 1.2], [1.5, 3]], 10),
	"8": () => [...arc(0, 0.6, 0.6, 90, -270, 24), ...arc(0, 1.8, 0.7, -90, 270, 24)],
	"0": () => arc(0, 0, 0.8, -90, 270, 40).map((p) => ({ x: p.x * 0.8, y: p.y * 1.4 })),
	o: () => arc(0, 0, 1, -90, 270, 40),
	a: () => [...arc(0, 0, 0.8, -20, -380, 36), ...q([[0.75, -0.3], [0.8, 1]], 6)],
	e: () => [...q([[-0.8, 0], [0.8, 0]], 6), ...arc(0, 0, 0.8, 0, -300, 36)],
	l: () => q([[0, 0], [0.05, 2.5]], 14),
	n: () => [...q([[0, 0], [0, 1.4]], 8), ...arc(0.55, 0.55, 0.55, 180, 360, 14), ...q([[1.1, 0.55], [1.1, 1.4]], 6)],
	m: () => [...q([[0, 1.4], [0, 0]], 8), ...arc(0.4, 0.4, 0.4, 180, 360, 10), ...q([[0.8, 0.4], [0.8, 1.4]], 6), ...q([[0.8, 0.4], [0.8, 0.4]], 1), ...arc(1.2, 0.4, 0.4, 180, 360, 10), ...q([[1.6, 0.4], [1.6, 1.4]], 6)],
	w: () => q([[0, 0], [0.5, 1.4], [1, 0.3], [1.5, 1.4], [2, 0]], 10),
	v: () => q([[0, 0], [0.7, 1.4], [1.4, 0]], 12),
	x: () => q([[0, 0], [1.2, 1.4], [1.2, 0], [0, 1.4]], 10),
	t: () => q([[0.6, 0], [0.6, 2], [1, 2.2], [1.3, 2.1]], 8),
	z: () => q([[0, 0], [1.2, 0], [0, 1.4], [1.2, 1.4]], 10),
	N: () => q([[0, 2], [0, 0], [1.4, 2], [1.4, 0]], 12),
	H: () => q([[0, 0], [0, 2], [0, 1], [1.4, 1], [1.4, 0], [1.4, 2]], 10),
	A: () => q([[0, 2], [0.8, 0], [1.6, 2], [1.2, 1.2], [0.4, 1.2]], 10),
	M: () => q([[0, 2], [0, 0], [0.8, 1.2], [1.6, 0], [1.6, 2]], 10),
	E: () => q([[1.2, 0], [0, 0], [0, 1], [1, 1], [0, 1], [0, 2], [1.2, 2]], 10),
	plus: () => q([[0, 1], [2, 1], [1, 1], [1, 0], [1, 2]], 10),
	zigzagWriting: () => q([[0, 0], [0.4, 0.6], [0.8, 0], [1.2, 0.6], [1.6, 0], [2, 0.6], [2.4, 0], [2.8, 0.6]], 8),
	wave: () => arc(0, 0, 1, 180, 540, 40).map((p, i) => ({ x: i * 0.08, y: p.y * 0.4 })),
	underline: () => q([[0, 0], [3, 0.1]], 24),
	check: () => q([[0, 1], [0.5, 1.7], [1.8, 0]], 10),
	bracket: () => q([[1, 0], [0, 0], [0, 2], [1, 2]], 10),
};
