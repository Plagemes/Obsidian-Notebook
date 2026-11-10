/**
 * 0.29 (review R3-1): the redaction guard of Undo and Redo. Pure: no 'obsidian', no DOM.
 *
 * A move of ink (Reorder lines, a table row or column insert, a lasso move, a transform, a margin shift) is refused when it changes what lies
 * under a redaction box (`movesUnderRedaction`). Its Undo and its Redo are moves too: undoing a reorder after a box was drawn over the moved
 * line slides that line back out from under the box, and the next export shows it in clear. This module compares a page before and after one
 * undo or redo step and tells whether the step moved anything out from under, or under, a box of that page; the view refuses such a step
 * (History `StepCheck`), and the step stays in the history.
 *
 * What counts as moved (the rules the tests pin):
 * - a stroke that is on the same page before and after (same id), as a different object, with the same number of points and different
 *   coordinates (a translation, a scale, a turn). A stroke whose number of points changes was reshaped (a hook trimmed at pen-up, smoothed,
 *   joined), not moved, and is left to the ordinary rules.
 * - an element that is on the same page before and after, whose position or size (`x`, `y`, `width`, `height`, `rotation`) changed.
 *   A text edit or a restyle is not a move.
 * - a stroke or an element that leaves a page where it touched a box and is found on another page after the step (a move to another page).
 * Ink that only appears (an erase undone) or disappears (a stroke undone) is not a move: a box cuts whatever lies under it at export.
 * Fail closed: when the stored boxes cannot be read, any move on any page refuses the step.
 */
import type { NotebookDocument, Page, PageElement, Stroke } from "../model/types";
import type { RedactBox } from "../model/redact";
import type { StepCheck } from "../model/history";
import { movesUnderRedaction, type RedactGuard } from "./redact";

/** The redaction boxes as the guard sees them: the boxes of a page, and whether the stored boxes could not be read. */
export interface StepBoxes {
	boxesOf(pageId: string): readonly RedactBox[];
	unreadable: boolean;
	/** Any box in the notebook at all (false: nothing to guard, nothing is captured). */
	any: boolean;
}

interface PageShot {
	id: string;
	strokes: readonly Stroke[];
	elements: readonly PageElement[];
}

/** The pages a step must be checked on, as they are before it: those with boxes (every page when the boxes cannot be read). Null: nothing to check. */
export function captureForStep(doc: NotebookDocument, boxes: StepBoxes): PageShot[] | null {
	if (!boxes.unreadable && !boxes.any) return null;
	const out: PageShot[] = [];
	for (const p of doc.pages) {
		if (!boxes.unreadable && boxes.boxesOf(p.id).length === 0) continue;
		out.push({ id: p.id, strokes: [...p.strokes], elements: [...(p.elements ?? [])] });
	}
	return out.length > 0 ? out : null;
}

/** False when `b` is `a` moved: the same number of points, other coordinates (a reshape, with another number of points, is not a move). */
const notMoved = (a: Stroke, b: Stroke): boolean => {
	if (a.points.length !== b.points.length) return true;
	for (let i = 0; i < a.points.length; i++) {
		const p = a.points[i]!;
		const q = b.points[i]!;
		if (p[0] !== q[0] || p[1] !== q[1]) return false;
	}
	return true;
};

const GEOMETRY = ["x", "y", "width", "height", "rotation"] as const;

const sameGeometry = (a: PageElement, b: PageElement): boolean => {
	const ra = a as unknown as Record<string, unknown>;
	const rb = b as unknown as Record<string, unknown>;
	return GEOMETRY.every((k) => ra[k] === rb[k]);
};

/**
 * True when the step that took the document from `before` (taken by `captureForStep`) to `doc` moved ink or an element out from under, or
 * under, a redaction box of its page (see the module comment for what counts as moved).
 */
export function stepMovesUnderRedaction(before: readonly PageShot[], doc: NotebookDocument, boxes: StepBoxes): boolean {
	const pages = new Map<string, Page>();
	for (const p of doc.pages) pages.set(p.id, p);
	for (const shot of before) {
		const guard: RedactGuard = { boxes: boxes.boxesOf(shot.id), ...(boxes.unreadable ? { unreadable: true } : {}) };
		const page = pages.get(shot.id);
		// A page the step removed takes its ink with it: nothing is moved on it.
		if (!page) continue;
		const nowStrokes = new Set<Stroke>(page.strokes);
		const nowElements = new Set<PageElement>(page.elements ?? []);
		const strokeNow = new Map<string, Stroke>();
		for (const s of page.strokes) strokeNow.set(s.id, s);
		const elementNow = new Map<string, PageElement>();
		for (const el of page.elements ?? []) elementNow.set(el.id, el);
		const moved = { before: { strokes: [] as Stroke[], elements: [] as PageElement[] }, after: { strokes: [] as Stroke[], elements: [] as PageElement[] } };
		const left = { strokes: [] as Stroke[], elements: [] as PageElement[] };
		for (const s of shot.strokes) {
			if (nowStrokes.has(s)) continue;
			const now = strokeNow.get(s.id);
			if (!now) left.strokes.push(s);
			else if (!notMoved(s, now)) {
				moved.before.strokes.push(s);
				moved.after.strokes.push(now);
			}
		}
		for (const el of shot.elements) {
			if (nowElements.has(el)) continue;
			const now = elementNow.get(el.id);
			if (!now) left.elements.push(el);
			else if (!sameGeometry(el, now)) {
				moved.before.elements.push(el);
				moved.after.elements.push(now);
			}
		}
		if (movesUnderRedaction(guard, moved.before, moved.after)) return true;
		if (left.strokes.length + left.elements.length > 0 && leftToAnotherPage(left, shot.id, doc, guard)) return true;
	}
	return false;
}

/**
 * The History `StepCheck` of the redaction guard: `boxes` is read once per step (before it), `refused` is told when a step is refused (the
 * view shows a notice). Nothing is captured, and nothing is checked, while the notebook has no box and the boxes can be read.
 */
export function redactStepCheck(boxes: () => StepBoxes, refused: (step: "undo" | "redo") => void): StepCheck {
	return (doc, step) => {
		const known = boxes();
		const before = captureForStep(doc, known);
		if (!before) return null;
		return (after) => {
			if (!stepMovesUnderRedaction(before, after, known)) return false;
			refused(step);
			return true;
		};
	};
}

/** Of the items that left page `pageId`, those that touched a box of it and are on another page now: true when there is any. */
function leftToAnotherPage(left: { strokes: Stroke[]; elements: PageElement[] }, pageId: string, doc: NotebookDocument, guard: RedactGuard): boolean {
	const touching = {
		strokes: left.strokes.filter((s) => movesUnderRedaction(guard, { strokes: [s], elements: [] }, { strokes: [], elements: [] })),
		elements: left.elements.filter((el) => movesUnderRedaction(guard, { strokes: [], elements: [el] }, { strokes: [], elements: [] })),
	};
	if (touching.strokes.length + touching.elements.length === 0) return false;
	const ids = new Set<string>([...touching.strokes.map((s) => s.id), ...touching.elements.map((el) => el.id)]);
	for (const p of doc.pages) {
		if (p.id === pageId) continue;
		if (p.strokes.some((s) => ids.has(s.id)) || (p.elements ?? []).some((el) => ids.has(el.id))) return true;
	}
	return false;
}
