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
 *   coordinates (a translation, a scale, a turn). Review U5: with another number of points (a reshape: a hook trimmed at pen-up, a smoothing,
 *   a join, a piece left by an area erase) it is a move only when its bounds shifted by more than the reach of its pen and neither bounds
 *   holds the other (a resample that also moved it); a stroke that only grew or shrank in place leaves every remaining point where it was,
 *   and a box cuts ink point by point.
 * - review U3: an element on the same page before and after whose area as the export measures it (`redactBounds`: the text at its widest,
 *   a checkbox by its size) changed, unless the new area holds the old one: the export drops a whole element whose area touches a box, so
 *   an element that only grew (a longer text, a larger font) can only be dropped more, never uncovered. A restyle is not a move.
 * - review U1: a margin comment anchored on the page (`region`) whose region changed (a *Move line* step moves the comments of the line; a
 *   margin change and a PDF turn move them all). The export drops a comment whose region touches a box, with its replies.
 * - a stroke, an element or an anchored comment that leaves a page where it touched a box and is found on another page after the step (a move
 *   to another page), also when the step removed the page it left (review U6a); and one that arrives on a page from another captured page
 *   and touches a box there (review U6b).
 * - round-2 review (H1): the background of a page with boxes (the PDF page or the picture) that moves, grows or changes: its rectangle on the
 *   page (`backgroundRect`: a left margin, a page size) or what it shows (its asset, page, turn or crop). The boxes are page coordinates, so
 *   the background would slide out from under them, and a background-only page has no ink that would tell.
 * Ink that only appears (an erase undone) or disappears (a stroke undone) is not a move: a box cuts whatever lies under it at export.
 * Fail closed: when the stored boxes cannot be read, any move on a page the step names refuses the step (`refused(step, true)`: the view says
 * so with its own notice, review U2).
 */
import type { CommentRegion, NotebookDocument, Page, PageComment, PageCommentNote, PageElement, Point, Stroke } from "../model/types";
import { backgroundGeometry, backgroundKey, type RedactBox } from "../model/redact";
import { Batch, SetPageBackground, SetPageMargins, SetPageSize, type Command, type StepCheck, type StepInfo, type StepVerdict } from "../model/history";
import { backgroundRect, marginsAfterResize, marginsOf, type Rect } from "../model/margins";
import { ReplacePage } from "../model/page-restore";
import { INK_PAD, movesUnderRedaction, redactBounds, redactReach, type RedactGuard } from "./redact";

/** The redaction boxes as the guard sees them: the boxes of a page, and whether the stored boxes could not be read. */
export interface StepBoxes {
	boxesOf(pageId: string): readonly RedactBox[];
	unreadable: boolean;
	/** Any box in the notebook at all (false: nothing to guard, nothing is captured). */
	any: boolean;
}

/** A page as it was before a step: its lists (copied: a step may change them in place), not the items. */
export interface PageShot {
	id: string;
	strokes: readonly Stroke[];
	elements: readonly PageElement[];
	comments: readonly PageComment[];
	/** Round-2 review (H1): where the background is drawn (null: the page has no background) and what it shows (`backgroundKey`). */
	background: Rect | null;
	backgroundKey: string;
}

/** The background of `page` as a `PageShot` holds it. */
function backgroundOf(page: Page): { background: Rect | null; backgroundKey: string } {
	return { background: page.background ? backgroundRect(page) : null, backgroundKey: backgroundKey(page.background) };
}

/** Round-3 review: compared to 0.01 pt, like the stored values (a height less a bottom margin is not always exact in floating point). */
const near = (a: number, b: number): boolean => Math.round(a * 100) === Math.round(b * 100);
const sameRect = (a: Rect | null, b: Rect | null): boolean =>
	a === b || (a !== null && b !== null && near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height));

/**
 * Round-2 review (H1): the pages whose background `cmd` would move, stretch or change when it runs on `doc`. A margin change moves the
 * background and the ink together, out from under the boxes, which stay in page coordinates: the actions refuse it on a page with boxes,
 * like a PDF turn or crop. Pure: nothing runs. Round-3 review: also inside a wrapper that carries its command as `inner` (a merge is
 * `exemptFromLocks(Batch)`, Z1), and (Z2) a page size or orientation that moves or stretches the background (with or without margins), a
 * background replaced by another one ("Update PDF") and a page restore whose background is elsewhere or shows something else. A background
 * added to a page that had none, or taken away, is not counted: nothing the boxes covered can show. The export checks the same thing on
 * the page as it is (`staleRedactionPages`), so this is the early notice, not the only guard.
 */
export function backgroundShifts(doc: NotebookDocument, cmd: Command): string[] {
	const out: string[] = [];
	const walk = (c: Command): void => {
		if (c instanceof Batch) {
			for (const x of c.commands) walk(x);
			return;
		}
		const inner = (c as { inner?: unknown }).inner;
		if (typeof inner === "object" && inner !== null && "apply" in inner && "revert" in inner) {
			walk(inner as Command);
			return;
		}
		if (c instanceof SetPageMargins) {
			if (marginsOf({ margins: c.before }).left !== marginsOf({ margins: c.after }).left) out.push(c.pageId);
			return;
		}
		const page = (id: string): Page | undefined => doc.pages.find((p) => p.id === id);
		if (c instanceof SetPageSize) {
			const p = page(c.pageId);
			if (!p?.background) return;
			const margins = marginsAfterResize(p, c.after);
			if (!sameRect(backgroundRect(p), backgroundRect({ ...c.after, ...(margins ? { margins } : {}) }))) out.push(c.pageId);
			return;
		}
		if (c instanceof SetPageBackground) {
			const p = page(c.pageId);
			if (!p?.background) return;
			const next = { background: c.background, width: c.size.width, height: c.size.height, ...(p.margins ? { margins: p.margins } : {}) };
			if (backgroundGeometry(p) !== backgroundGeometry(next)) out.push(c.pageId);
			return;
		}
		if (c instanceof ReplacePage) {
			const a = backgroundGeometry(c.before);
			const b = backgroundGeometry(c.after);
			if (a !== "" && b !== "" && a !== b) out.push(c.before.id);
		}
	};
	walk(cmd);
	return out;
}

/**
 * The pages a step must be checked on, as they are before it. Null: nothing to check (the notebook has no box and the boxes can be read).
 * `pages` are the pages the step names (null: unknown, any page may change). Captured: every page with boxes, and every page the step names
 * (the boxes of a page ink arrives on are checked against what left the other page, U6b). Review U2: with unreadable boxes only the pages
 * the step names are captured, so a step of one page no longer copies the whole notebook.
 */
export function captureForStep(doc: NotebookDocument, boxes: StepBoxes, pages: ReadonlySet<string> | null = null): PageShot[] | null {
	if (!boxes.unreadable && !boxes.any) return null;
	const out: PageShot[] = [];
	for (const p of doc.pages) {
		const named = pages === null || pages.has(p.id);
		if (!named && (boxes.unreadable || boxes.boxesOf(p.id).length === 0)) continue;
		out.push({ id: p.id, strokes: [...p.strokes], elements: [...(p.elements ?? [])], comments: [...(p.comments ?? [])], ...backgroundOf(p) });
	}
	return out.length > 0 ? out : null;
}

interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

function pointBounds(points: readonly Point[]): Bounds | null {
	if (points.length === 0) return null;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of points) {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	return { minX, minY, maxX, maxY };
}

/** `outer` holds `inner`, give or take `slack` on each side. */
const holds = (outer: Bounds, inner: Bounds, slack = 0): boolean =>
	outer.minX <= inner.minX + slack && outer.minY <= inner.minY + slack && outer.maxX >= inner.maxX - slack && outer.maxY >= inner.maxY - slack;

const sameBounds = (a: Bounds, b: Bounds): boolean => a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;

/** True when `b` is `a` moved (see the module comment: same number of points at other coordinates, or a reshape that also shifted it, U5). */
function strokeMoved(a: Stroke, b: Stroke): boolean {
	if (a.points.length === b.points.length) {
		for (let i = 0; i < a.points.length; i++) {
			const p = a.points[i]!;
			const q = b.points[i]!;
			if (p[0] !== q[0] || p[1] !== q[1]) return true;
		}
		return false;
	}
	const ba = pointBounds(a.points);
	const bb = pointBounds(b.points);
	if (!ba || !bb) return false;
	const slack = Math.max(redactReach(a), redactReach(b)) + INK_PAD;
	const shifted = Math.abs(ba.minX - bb.minX) > slack || Math.abs(ba.minY - bb.minY) > slack
		|| Math.abs(ba.maxX - bb.maxX) > slack || Math.abs(ba.maxY - bb.maxY) > slack;
	return shifted && !holds(ba, bb, slack) && !holds(bb, ba, slack);
}

/** True when `b` is `a` moved for the export: its area changed and does not hold the old one (U3). */
function elementMoved(a: PageElement, b: PageElement): boolean {
	const ra = redactBounds(a);
	const rb = redactBounds(b);
	return !sameBounds(ra, rb) && !holds(rb, ra);
}

const sameRegion = (a: CommentRegion, b: CommentRegion): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const notesOf = (list: readonly PageComment[]): PageCommentNote[] => list.filter((c): c is PageCommentNote => "region" in c);

interface Items {
	strokes: Stroke[];
	elements: PageElement[];
	notes: PageCommentNote[];
}

const noItems = (): Items => ({ strokes: [], elements: [], notes: [] });
const size = (m: Items): number => m.strokes.length + m.elements.length + m.notes.length;
const asMove = (m: Items) => ({ strokes: m.strokes, elements: m.elements, regions: m.notes.map((c) => c.region) });
const NOTHING = { strokes: [], elements: [], regions: [] };

/**
 * True when the step that took the document from `before` (taken by `captureForStep`) to `doc` moved ink, an element or an anchored comment out
 * from under, or under, a redaction box of its page (see the module comment for what counts as moved).
 */
export function stepMovesUnderRedaction(before: readonly PageShot[], doc: NotebookDocument, boxes: StepBoxes): boolean {
	const pages = new Map<string, Page>();
	for (const p of doc.pages) pages.set(p.id, p);
	// U6b: the page each captured item was on before the step.
	const wasOn = new Map<string, string>();
	// Round-2 review (H5): comment ids are unique only within a page (a duplicated page keeps them), so the notes of each captured page are known by page.
	const notesBefore = new Map<string, Set<string>>();
	for (const shot of before) {
		for (const s of shot.strokes) wasOn.set(s.id, shot.id);
		for (const el of shot.elements) wasOn.set(el.id, shot.id);
		const notes = new Set<string>();
		for (const c of notesOf(shot.comments)) {
			wasOn.set(c.id, shot.id);
			notes.add(c.id);
		}
		notesBefore.set(shot.id, notes);
	}
	for (const shot of before) {
		const guard: RedactGuard = { boxes: boxes.boxesOf(shot.id), ...(boxes.unreadable ? { unreadable: true } : {}) };
		const page = pages.get(shot.id);
		if (!page) {
			// U6a: a page the step removed takes its items with it, unless they are found on another page now.
			const gone: Items = { strokes: [...shot.strokes], elements: [...shot.elements], notes: notesOf(shot.comments) };
			if (size(gone) > 0 && leftToAnotherPage(gone, shot.id, doc, guard, notesBefore)) return true;
			continue;
		}
		// Round-2 review (H1): the background of a page with boxes (or of any named page while the boxes cannot be read) stays where it was and
		// shows what it showed: a margin change, a page size or another background slides it out from under the boxes.
		if ((guard.boxes.length > 0 || guard.unreadable === true) && (shot.background !== null || page.background)) {
			const now = backgroundOf(page);
			if (!sameRect(shot.background, now.background) || shot.backgroundKey !== now.backgroundKey) {
				// Round-3 review (Z2): unless the step puts the background back where every box of the page was drawn (each box knows it,
				// `geo`): the Undo of a size change that moved it is the way back, never refused.
				const geo = backgroundGeometry(page);
				const back = guard.unreadable !== true && geo !== "" && guard.boxes.every((b) => b.geo === geo);
				if (!back) return true;
			}
		}
		const nowStrokes = new Set<Stroke>(page.strokes);
		const nowElements = new Set<PageElement>(page.elements ?? []);
		const strokeNow = new Map<string, Stroke>();
		for (const s of page.strokes) strokeNow.set(s.id, s);
		const elementNow = new Map<string, PageElement>();
		for (const el of page.elements ?? []) elementNow.set(el.id, el);
		const noteNow = new Map<string, PageCommentNote>();
		for (const c of notesOf(page.comments ?? [])) noteNow.set(c.id, c);
		const moved = { before: noItems(), after: noItems() };
		const left = noItems();
		for (const s of shot.strokes) {
			if (nowStrokes.has(s)) continue;
			const now = strokeNow.get(s.id);
			if (!now) left.strokes.push(s);
			else if (strokeMoved(s, now)) {
				moved.before.strokes.push(s);
				moved.after.strokes.push(now);
			}
		}
		for (const el of shot.elements) {
			if (nowElements.has(el)) continue;
			const now = elementNow.get(el.id);
			if (!now) left.elements.push(el);
			else if (elementMoved(el, now)) {
				moved.before.elements.push(el);
				moved.after.elements.push(now);
			}
		}
		// U1: the regions of the anchored comments are moved with their line, the margins or the PDF turn.
		const had = new Set<string>();
		for (const c of notesOf(shot.comments)) {
			had.add(c.id);
			const now = noteNow.get(c.id);
			if (!now) left.notes.push(c);
			else if (!sameRegion(c.region, now.region)) {
				moved.before.notes.push(c);
				moved.after.notes.push(now);
			}
		}
		if (movesUnderRedaction(guard, asMove(moved.before), asMove(moved.after))) return true;
		if (size(left) > 0 && leftToAnotherPage(left, shot.id, doc, guard, notesBefore)) return true;
		// U6b: what arrived on this page from another captured page (a move to another page) and lies under a box here now.
		for (const s of shot.strokes) had.add(s.id);
		for (const el of shot.elements) had.add(el.id);
		const fromOther = (id: string): boolean => !had.has(id) && wasOn.has(id) && wasOn.get(id) !== shot.id;
		const arrived: Items = {
			strokes: page.strokes.filter((s) => fromOther(s.id)),
			elements: (page.elements ?? []).filter((el) => fromOther(el.id)),
			notes: [...noteNow.values()].filter((c) => fromOther(c.id)),
		};
		if (size(arrived) > 0 && movesUnderRedaction(guard, NOTHING, asMove(arrived))) return true;
	}
	return false;
}

/**
 * The History `StepCheck` of the redaction guard. `boxes` is read once per step (before it), or once per run of steps (a history-panel jump,
 * review U7: the store is read and parsed once for the whole slice). `refused` is told when a step is refused and back where it was (round-2
 * review H4: through the verdict, which the history calls only then), with `unreadable` true when it
 * was refused only because the stored boxes cannot be read (the view shows another notice, U2). Nothing is captured, and nothing is checked,
 * while the notebook has no box and the boxes can be read.
 */
export function redactStepCheck(boxes: () => StepBoxes, refused: (step: "undo" | "redo", unreadable: boolean) => void): StepCheck {
	let cached: { run: object; boxes: StepBoxes } | null = null;
	const read = (info: StepInfo | undefined): StepBoxes => {
		const run = info?.run ?? null;
		if (run && cached?.run === run) return cached.boxes;
		const known = boxes();
		cached = run ? { run, boxes: known } : null;
		return known;
	};
	return (doc, step, info) => {
		const known = read(info);
		const before = captureForStep(doc, known, info?.pages ?? null);
		if (!before) return null;
		// Round-2 review (H4): the notice is a function the history calls only once the step is back where it was (not when taking it back failed).
		return (after): StepVerdict => (stepMovesUnderRedaction(before, after, known) ? () => refused(step, known.unreadable) : false);
	};
}

/**
 * Of the items that left page `pageId`, those that touched a box of it and are on another page now: true when there is any. Round-2 review
 * (H5): a comment id is unique only within its page, so a note found on another page is the one that left only when that page was captured
 * (`notesBefore`: the note ids of each captured page before the step) and did not have it before; a page the step does not name cannot have
 * received it.
 */
function leftToAnotherPage(left: Items, pageId: string, doc: NotebookDocument, guard: RedactGuard, notesBefore: ReadonlyMap<string, ReadonlySet<string>>): boolean {
	const touches = (m: { strokes: readonly Stroke[]; elements: readonly PageElement[]; regions: readonly CommentRegion[] }): boolean =>
		movesUnderRedaction(guard, m, NOTHING);
	const ids = new Set<string>([
		...left.strokes.filter((s) => touches({ strokes: [s], elements: [], regions: [] })).map((s) => s.id),
		...left.elements.filter((el) => touches({ strokes: [], elements: [el], regions: [] })).map((el) => el.id),
	]);
	const noteIds = new Set<string>(left.notes.filter((c) => touches({ strokes: [], elements: [], regions: [c.region] })).map((c) => c.id));
	if (ids.size === 0 && noteIds.size === 0) return false;
	for (const p of doc.pages) {
		if (p.id === pageId) continue;
		if (p.strokes.some((s) => ids.has(s.id)) || (p.elements ?? []).some((el) => ids.has(el.id))) return true;
		const had = notesBefore.get(p.id);
		if (had && notesOf(p.comments ?? []).some((c) => noteIds.has(c.id) && !had.has(c.id))) return true;
	}
	return false;
}
