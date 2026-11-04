import { boundGraphId } from "../ink/attach";
import { captureClip, instantiateClip } from "../ink/clipboard";
import { elementBounds, transformElement } from "../ink/elements";
import { strokeBounds, type BBox } from "../ink/hit-test";
import { transformStroke } from "../ink/lasso";
import type { MeasureText } from "../ink/text-layout";
import { estimateMeasure } from "../ink/text-layout";
import { translate } from "../ink/transform";
import { AddElement, AddStroke, Batch, RemoveElement, removeStrokes, type Command } from "./history";
import { freezeElement, freezeStroke } from "./serialize";
import { SetPageStates, withoutItems } from "./states";
import type { NotebookDocument, PageElement, Stroke } from "./types";

/**
 * Move or copy a selection to another page of the same notebook (roadmap #78). Pure: no view, no Obsidian.
 *
 * Move: the strokes and elements leave the source page and join the end of the target page (on top) with the SAME ids, as ONE
 * undo step (`Batch`: removals, then additions; undo reverses them). Same ids keep everything that refers to an id valid:
 * slide links (`Stroke.slide` names an entry of the notebook-wide `doc.slides`, so a moved stroke still shows its slide), the
 * asset records of images (notebook-wide), and ink bound to a graph (`<graph id>~<n>`, moved together with the graph).
 *
 * Drawings with states: `Page.states` lists stroke ids per part of ONE page. A stroke that is a member of a part cannot stay in
 * it on another page, so it LEAVES the part (the part loses that member; a part left empty goes with its poses, as when the
 * stroke is erased). The same command restores the part table on undo. The alternative (refusing to move members) was
 * rejected: it would make a lasso that happens to graze a drawing impossible to move, and nothing is lost: the strokes keep
 * their as-drawn geometry, and `leftParts` tells the caller to say so.
 *
 * Copy: new ids (a copy of a graph and its bound ink gets a fresh binding), keeps `slide`, added to the end of the target page.
 *
 * Position: by default the selection keeps its place and is clamped into the target page (a smaller page pulls it in; a
 * selection larger than the page sits at the top-left); `exact` keeps the coordinates as they are, even outside a smaller page.
 */

export type MoveMode = "move" | "copy";

export interface MoveRequest {
	doc: NotebookDocument;
	/** Page the items are on, and the page they go to (indices into `doc.pages`). */
	from: number;
	to: number;
	strokes: readonly Stroke[];
	elements: readonly PageElement[];
	mode: MoveMode;
	/** Keep the exact coordinates instead of clamping into the target page. */
	exact?: boolean;
	measure?: MeasureText;
}

export type MoveRefusal = "same-page" | "missing-page" | "nothing" | "bound-ink";

export interface MovePlan {
	command: Command;
	/** The items as they are on the target page after the change (new objects when moved by an offset). */
	strokes: Stroke[];
	elements: PageElement[];
	/** Offset applied (pt). */
	dx: number;
	dy: number;
	/** Members of drawing-with-states parts that left their part (move only). */
	leftParts: number;
	/** How many items went (strokes + elements). */
	count: number;
}

export function planMoveToPage(req: MoveRequest): MovePlan | { refused: MoveRefusal } {
	const { doc, from, to } = req;
	const source = doc.pages[from];
	const target = doc.pages[to];
	if (!source || !target) return { refused: "missing-page" };
	if (from === to) return { refused: "same-page" };
	const measure = req.measure ?? estimateMeasure;
	const elements = req.elements.filter((e) => source.elements?.includes(e));
	let strokes = req.strokes.filter((s) => source.strokes.includes(s));

	// Ink bound to a selected graph goes with it; ink bound to a graph that stays behind cannot leave it.
	const graphs = new Set(elements.filter((e) => e.type === "graph").map((e) => e.id));
	if (graphs.size > 0) {
		const have = new Set(strokes);
		strokes = [...strokes, ...source.strokes.filter((s) => !have.has(s) && graphs.has(boundGraphId(s) ?? ""))];
	}
	if (strokes.length + elements.length === 0) return { refused: "nothing" };
	if (strokes.some((s) => {
		const g = boundGraphId(s);
		return g !== null && !graphs.has(g) && (source.elements ?? []).some((e) => e.type === "graph" && e.id === g);
	})) return { refused: "bound-ink" };

	const box = boundsOf(strokes, elements, measure);
	const [dx, dy] = req.exact || !box ? [0, 0] : clampOffset(box, target);

	if (req.mode === "copy") {
		const clip = captureClip(strokes, elements, doc.assets, measure);
		if (!clip) return { refused: "nothing" };
		const made = instantiateClip(clip, dx, dy, undefined, measure);
		const commands: Command[] = [];
		made.strokes.forEach((s, i) => commands.push(new AddStroke(target.id, s, target.strokes.length + i)));
		made.elements.forEach((e, i) => commands.push(new AddElement(target.id, e, (target.elements?.length ?? 0) + i)));
		return { command: new Batch("Copy selection to page", commands), strokes: made.strokes, elements: made.elements, dx, dy, leftParts: 0, count: made.strokes.length + made.elements.length };
	}

	const m = translate(dx, dy);
	const moved = dx === 0 && dy === 0;
	const newStrokes = strokes.map((s) => (moved ? s : freezeStroke(transformStroke(s, m))));
	const newElements = elements.map((e) => (moved ? e : freezeElement(transformElement(e, m, measure))));
	const commands: Command[] = [];
	const removal = removeStrokes(source.id, source.strokes, strokes, "Move selection to page");
	if (removal) commands.push(removal);
	for (const e of elements) commands.push(new RemoveElement(source.id, e));
	newStrokes.forEach((s, i) => commands.push(new AddStroke(target.id, s, target.strokes.length + i)));
	newElements.forEach((e, i) => commands.push(new AddElement(target.id, e, (target.elements?.length ?? 0) + i)));
	const ids = new Set(strokes.map((s) => s.id));
	const leftParts = source.states ? source.states.parts.reduce((n, p) => n + p.items.filter((id) => ids.has(id)).length, 0) : 0;
	if (leftParts > 0) commands.push(new SetPageStates(source.id, source.states, withoutItems(source.states, ids), "Move selection to page"));
	return { command: new Batch("Move selection to page", commands), strokes: newStrokes, elements: newElements, dx, dy, leftParts, count: newStrokes.length + newElements.length };
}

function boundsOf(strokes: readonly Stroke[], elements: readonly PageElement[], measure: MeasureText): BBox | null {
	const boxes = [...strokes.map(strokeBounds), ...elements.map((e) => elementBounds(e, measure))];
	if (boxes.length === 0) return null;
	return boxes.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
}

/** The smallest offset (rounded to 0.01 pt) that puts `box` inside the page; a box wider than the page sits at 0. */
export function clampOffset(box: BBox, page: { width: number; height: number }): [number, number] {
	return [shiftInto(box.minX, box.maxX, page.width), shiftInto(box.minY, box.maxY, page.height)];
}

function shiftInto(min: number, max: number, limit: number): number {
	if (max - min >= limit) return Math.round(-min * 100) / 100;
	if (min < 0) return Math.round(-min * 100) / 100;
	if (max > limit) return Math.round((limit - max) * 100) / 100;
	return 0;
}

/** Whether a page is a legal target: any other page of the notebook. */
export function targetPages(doc: Pick<NotebookDocument, "pages">, from: number): number[] {
	return doc.pages.map((_, i) => i).filter((i) => i !== from);
}
