import { normalise, rankTemplates, similarity, TEMPLATE_POINTS, type Template } from "./dollar";
import { boundsOf, pathLength, type Pt } from "./geometry";
import { MIN_GESTURE_PATH_PX } from "./shapes";

/** Custom gestures: the user's own strokes, three samples each, bound to an Obsidian command. */
export interface CustomGesture {
	id: string;
	name: string;
	/** Id of the Obsidian command to run, as in `app.commands`. */
	command: string;
	enabled: boolean;
	/** One normalised path per sample, `[x, y]` pairs. */
	samples: Array<Array<[number, number]>>;
}

export const SAMPLES_REQUIRED = 3;
export const MAX_CUSTOM_GESTURES = 24;
/** The samples of one gesture must resemble each other at least this much (0..1). */
export const SAMPLE_CONSISTENCY = 0.74;
/** A stroke is the gesture when its best template scores this much... */
export const CUSTOM_MIN_SCORE = 0.82;
/** ...and the next custom gesture is this far behind. */
export const CUSTOM_MARGIN = 0.04;

export type SampleError = "samples" | "short" | "inconsistent" | "builtin";

const toTuples = (pts: readonly Pt[]): Array<[number, number]> => pts.map((p) => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000]);
const fromTuples = (t: ReadonlyArray<readonly [number, number]>): Pt[] => t.map(([x, y]) => ({ x, y }));

/** Is the stroke big enough to be a gesture at all? (A tap or a speck is not.) */
export function sampleBigEnough(pts: readonly Pt[]): boolean {
	const box = boundsOf(pts);
	return pathLength(pts) >= MIN_GESTURE_PATH_PX && Math.max(box.w, box.h) >= 30;
}

/**
 * Builds a custom gesture from raw strokes (CSS px). Fails when there are not exactly three usable samples, when one is
 * too small, when they do not look alike, or when `isBuiltIn` says a sample is already one of the built-in gestures.
 */
export function buildCustomGesture(
	id: string, name: string, command: string, strokes: ReadonlyArray<readonly Pt[]>, isBuiltIn: (pts: readonly Pt[]) => boolean = () => false,
): { gesture: CustomGesture } | { error: SampleError } {
	if (strokes.length !== SAMPLES_REQUIRED) return { error: "samples" };
	if (!strokes.every(sampleBigEnough)) return { error: "short" };
	const paths = strokes.map((s) => normalise(s));
	if (paths.some((p) => p === null)) return { error: "short" };
	const norm = paths as Pt[][];
	for (let i = 0; i < norm.length; i++) {
		for (let j = i + 1; j < norm.length; j++) if (similarity(norm[i]!, norm[j]!) < SAMPLE_CONSISTENCY) return { error: "inconsistent" };
	}
	if (strokes.some((s) => isBuiltIn(s))) return { error: "builtin" };
	return { gesture: { id, name, command, enabled: true, samples: norm.map(toTuples) } };
}

export interface CustomMatch {
	gesture: CustomGesture;
	score: number;
}

/** The custom gesture the stroke is, or null: best template at least `CUSTOM_MIN_SCORE`, clear of the runner-up. */
export function matchCustom(pts: readonly Pt[], gestures: readonly CustomGesture[]): CustomMatch | null {
	if (!sampleBigEnough(pts)) return null;
	const templates: Template[] = [];
	for (const g of gestures) {
		if (!g.enabled) continue;
		for (const s of g.samples) templates.push({ name: g.id, points: fromTuples(s) });
	}
	const ranked = rankTemplates(pts, templates);
	const best = ranked[0];
	if (!best || best.score < CUSTOM_MIN_SCORE) return null;
	const second = ranked[1];
	if (second && best.score - second.score < CUSTOM_MARGIN) return null;
	const gesture = gestures.find((g) => g.id === best.name);
	return gesture ? { gesture, score: best.score } : null;
}

/** Parses saved custom gestures; anything malformed is dropped. */
export function parseCustomGestures(value: unknown): CustomGesture[] {
	if (!Array.isArray(value)) return [];
	const out: CustomGesture[] = [];
	const seen = new Set<string>();
	for (const raw of value) {
		if (out.length >= MAX_CUSTOM_GESTURES) break;
		if (typeof raw !== "object" || raw === null) continue;
		const g = raw as Record<string, unknown>;
		if (typeof g.id !== "string" || !g.id || g.id.length > 64 || seen.has(g.id)) continue;
		if (typeof g.name !== "string" || typeof g.command !== "string" || !g.command || g.command.length > 200) continue;
		if (!Array.isArray(g.samples) || g.samples.length < 1 || g.samples.length > 6) continue;
		const samples: Array<Array<[number, number]>> = [];
		let ok = true;
		for (const s of g.samples) {
			if (!Array.isArray(s) || s.length !== TEMPLATE_POINTS) {
				ok = false;
				break;
			}
			const pts: Array<[number, number]> = [];
			for (const p of s) {
				if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0] as number) > 4 || Math.abs(p[1] as number) > 4) {
					ok = false;
					break;
				}
				pts.push([p[0] as number, p[1] as number]);
			}
			if (!ok) break;
			samples.push(pts);
		}
		if (!ok) continue;
		seen.add(g.id);
		out.push({ id: g.id, name: g.name.slice(0, 60), command: g.command, enabled: g.enabled !== false, samples });
	}
	return out;
}
