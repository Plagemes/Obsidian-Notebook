import { rankTemplates, normalise, type Template } from "./dollar";
import { boundsOf, pathLength, resample, smooth, turn, type Pt } from "./geometry";
import { GLYPHS, QUESTION_NAMES } from "./glyphs";
import { MIN_GESTURE_PATH_PX, type ShapeMatch } from "./shapes";

let cache: Template[] | null = null;

function templates(): Template[] {
	if (!cache) {
		cache = [];
		for (const [name, make] of Object.entries(GLYPHS)) {
			const points = normalise(make());
			if (points) cache.push({ name, points });
		}
	}
	return cache;
}

/** Closest the "?" must be to its template, and by how much it must beat the look-alikes (2, 3, 5, 7, 9, S, J, 6). */
export const QUESTION_MIN_SCORE = 0.8;
export const QUESTION_MARGIN = 0.03;

export interface QuestionMatch extends ShapeMatch {
	/** Where the hook starts. */
	start: Pt;
}

/**
 * "?" drawn as one stroke (the hook and the stem; the dot is not needed). Template matching against the question-mark
 * paths and, to keep digits and letters out, against their closest look-alikes: the "?" has to win.
 */
export function matchQuestion(pts: readonly Pt[]): QuestionMatch | null {
	if (pts.length < 8 || pathLength(pts) < MIN_GESTURE_PATH_PX) return null;
	const box = boundsOf(pts);
	if (box.h < 40 || box.h / Math.max(1, box.w) < 1.15) return null;
	// A hook: at least 170 degrees of bending in total (a "1", an "l" or a plain stem have none).
	const path = smooth(resample(pts, 40), 2);
	let bend = 0;
	for (let i = 1; i < path.length - 1; i++) bend += Math.abs(turn(path[i - 1]!, path[i]!, path[i + 1]!));
	if (bend < (170 * Math.PI) / 180) return null;
	const ranked = rankTemplates(pts, templates());
	const best = ranked[0];
	if (!best || !(QUESTION_NAMES as readonly string[]).includes(best.name) || best.score < QUESTION_MIN_SCORE) return null;
	const rival = ranked.find((r) => !(QUESTION_NAMES as readonly string[]).includes(r.name));
	if (rival && best.score - rival.score < QUESTION_MARGIN) return null;
	return { score: best.score, start: pts[0]! };
}
