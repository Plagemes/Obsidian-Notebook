import type { Pt } from "./geometry";

/**
 * Hand-built reference paths (unit-ish size, y down) of a few characters. "?" is the template of the search gesture;
 * the others are rivals that look a little like it: a candidate that is closer to one of them than to "?" is not a
 * question mark. They also serve the tests as stand-ins for handwriting.
 */
const DEG = Math.PI / 180;

/** Points on an arc of the circle (cx, cy, r) from angle `a0` to `a1` degrees (y down: 270 = top, increasing = clockwise on screen). */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 24): Pt[] {
	const out: Pt[] = [];
	for (let i = 0; i <= n; i++) {
		const a = (a0 + ((a1 - a0) * i) / n) * DEG;
		out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
	}
	return out;
}

/** Straight run through the given corners, `n` points per leg. */
export function poly(corners: ReadonlyArray<readonly [number, number]>, n = 10): Pt[] {
	const out: Pt[] = [];
	for (let i = 1; i < corners.length; i++) {
		const [ax, ay] = corners[i - 1]!, [bx, by] = corners[i]!;
		for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push({ x: ax + ((bx - ax) * k) / n, y: ay + ((by - ay) * k) / n });
	}
	return out;
}

const join = (...parts: Pt[][]): Pt[] => parts.flat();

export const GLYPHS: Record<string, () => Pt[]> = {
	// Hook over the top, curving in to the middle, then straight down.
	"?": () => join(arc(0, 0, 1, 190, 400), poly([[0.65, 0.76], [0.2, 1.25], [0, 1.6], [0, 2.4]], 8)),
	// Same hook, a more open one.
	"?-open": () => join(arc(0, 0, 1, 205, 385), poly([[0.8, 0.6], [0.3, 1.2], [0.05, 1.7], [0.05, 2.5]], 8)),
	"2": () => join(arc(0, 0, 1, 190, 380), poly([[0.98, 0.17], [-1, 2.2], [1.05, 2.2]], 14)),
	"3": () => join(arc(0, 0.55, 0.55, 200, 450), arc(0, 1.65, 0.55, 270, 520)),
	"5": () => join(poly([[0.9, 0], [-0.6, 0], [-0.75, 0.95]], 10), arc(0, 1.5, 0.95, 235, 495)),
	"7": () => poly([[-1, 0], [1, 0], [-0.3, 2.4]], 14),
	"9": () => join(arc(0, 0, 0.8, 0, 360), poly([[0.8, 0], [0.8, 2]], 10)),
	"S": () => join(arc(0, 0.55, 0.55, 320, 90), arc(0, 1.65, 0.55, 270, 500)),
	"J": () => join(poly([[0.6, 0], [0.6, 1.7]], 10), arc(0, 1.7, 0.6, 0, 150, 12)),
	"6": () => join(poly([[0.5, 0], [-0.55, 1.2]], 8), arc(0, 1.55, 0.7, 200, -160, 30)),
};

/** The names the "?" recogniser compares a candidate against (the first two are the question-mark templates). */
export const QUESTION_NAMES = ["?", "?-open"] as const;
