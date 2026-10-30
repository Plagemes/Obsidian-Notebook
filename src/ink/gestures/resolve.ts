import { matchCustom, type CustomGesture } from "./custom";
import { boundsOf, dedupe, type Pt, type TrailPoint } from "./geometry";
import { matchQuestion } from "./question";
import type { BuiltInGestureId } from "./registry";
import { isRetrace, matchCaret, matchCircle, matchHash, matchLine, matchStar } from "./shapes";

/**
 * What the gesture needs to know about the page, answered by the view in screen px (CSS px, relative to the stage).
 * Keeping it behind an interface keeps the recognisers testable without Obsidian, a DOM or a document.
 */
export interface GestureWorld {
	/** How many strokes or objects the closed loop encloses (the circle selects them). */
	enclosedInk(loop: readonly Pt[]): number;
	/** How many strokes a scribble along this trail would delete (0 when it is not a scribble or touches no ink). */
	scribbleVictims(trail: readonly TrailPoint[]): number;
	/** Is there a page under the point? */
	onPage(p: Pt): boolean;
	/** Is there a selection and is the point on it? */
	onSelection(p: Pt): boolean;
	/** Index of the page whose navigator thumbnail is under the point, or -1. */
	thumbnailAt(p: Pt): number;
	/** Page index the current selection is on, or -1 without a selection. */
	selectionPage(): number;
}

export interface RecogniseOptions {
	world: GestureWorld;
	/** Built-in gestures the user switched off. */
	disabled: ReadonlySet<string>;
	custom: readonly CustomGesture[];
}

export type Recognition =
	| { type: "none" }
	/** The pen went back along the stroke: nothing will happen. */
	| { type: "cancel" }
	| { type: "builtin"; id: BuiltInGestureId; score: number; anchor: Pt; target?: number }
	| { type: "custom"; gesture: CustomGesture; score: number; anchor: Pt };

const NONE: Recognition = { type: "none" };

/**
 * Reads the gesture stroke. The shape alone never decides: a circle needs ink inside it, a scribble ink under it, a "^",
 * "#" or star a page, and the arrow a selection at its tail and a navigator thumbnail at its tip. Built-in gestures win
 * over custom ones (a custom gesture that looks like a built-in one is refused when it is recorded).
 */
export function recognise(trail: readonly TrailPoint[], opts: RecogniseOptions): Recognition {
	const pts = dedupe(trail, 1.5);
	if (pts.length < 3) return NONE;
	if (isRetrace(pts)) return { type: "cancel" };
	const { world, disabled } = opts;
	const on = (id: BuiltInGestureId): boolean => !disabled.has(id);
	let best: Recognition = NONE;
	let bestScore = 0;
	const offer = (r: Recognition & { type: "builtin" }): void => {
		if (r.score > bestScore) {
			best = r;
			bestScore = r.score;
		}
	};

	if (on("select")) {
		const m = matchCircle(pts);
		if (m && world.enclosedInk(pts) > 0) offer({ type: "builtin", id: "select", score: m.score, anchor: m.center });
	}
	if (on("delete") && world.scribbleVictims(trail) > 0) {
		const b = boundsOf(pts);
		offer({ type: "builtin", id: "delete", score: 0.95, anchor: { x: b.minX + b.w / 2, y: b.minY + b.h / 2 } });
	}
	if (on("space")) {
		const m = matchCaret(pts);
		if (m && world.onPage(m.apex)) offer({ type: "builtin", id: "space", score: m.score, anchor: m.apex });
	}
	if (on("tag")) {
		const m = matchHash(pts);
		if (m && world.onPage(m.center)) offer({ type: "builtin", id: "tag", score: m.score, anchor: m.center });
	}
	if (on("bookmark")) {
		const m = matchStar(pts);
		if (m && world.onPage(m.center)) offer({ type: "builtin", id: "bookmark", score: m.score, anchor: m.center });
	}
	if (on("search")) {
		const m = matchQuestion(pts);
		if (m) offer({ type: "builtin", id: "search", score: m.score, anchor: m.start });
	}
	if (on("move")) {
		const m = matchLine(pts);
		if (m && world.onSelection(m.from)) {
			const target = world.thumbnailAt(m.to);
			if (target >= 0 && target !== world.selectionPage()) offer({ type: "builtin", id: "move", score: m.score, anchor: m.to, target });
		}
	}
	if (best.type !== "none") return best;

	const c = matchCustom(pts, opts.custom);
	if (c) {
		const b = boundsOf(pts);
		return { type: "custom", gesture: c.gesture, score: c.score, anchor: { x: b.minX + b.w / 2, y: b.minY + b.h / 2 } };
	}
	return NONE;
}

/** Does any built-in shape recogniser claim this stroke, regardless of context? (Used when recording a custom gesture.) */
export function looksBuiltIn(pts: readonly Pt[]): boolean {
	const p = dedupe(pts, 1.5);
	return !!(matchCircle(p) || matchCaret(p) || matchHash(p) || matchStar(p) || matchQuestion(p) || matchLine(p) || isRetrace(p));
}
