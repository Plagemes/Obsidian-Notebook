// 0.28 (#76, format v26): the History command that rotates or crops the PDF background of a page. One command = one undo step: the background
// fields, the page size and margins, and every item on the page (strokes, elements, areas, comment regions, the pivots and poses of the states)
// move together, so nothing is left behind or on the wrong part of the PDF.
import { elementBounds, transformElement } from "../ink/elements";
import { strokeBounds } from "../ink/hit-test";
import { transformStroke } from "../ink/lasso";
import { emptyPlacement, inkOwnership, rotationKeepsOrientation, type Placement } from "../ink/selection-transform";
import { estimateMeasure, type MeasureText } from "../ink/text-layout";
import { apply, isIdentity, translate, type Matrix } from "../ink/transform";
import { findPage } from "./document";
import { transformComments } from "./comments";
import { swapItem, type Command, type ElementSwap } from "./history";
import { planPdfView, type ContentBox, type PdfView, type PdfViewPlan } from "./pdf-view";
import { freezeElement, freezeStroke } from "./serialize";
import { transformStates } from "./states";
import type { NotebookDocument, Page, PageBackground, PageComment, PageElement, PageMargins, PageStates, Stroke } from "./types";

/** The bounds of every stroke (hidden ones too) and element of `page`, for `planPdfView`. */
export function pageContentBoxes(page: Page, measure: MeasureText = estimateMeasure): ContentBox[] {
	const boxes: ContentBox[] = [];
	for (const s of page.strokes) {
		if (s.points.length === 0) continue;
		const b = strokeBounds(s);
		boxes.push({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });
	}
	for (const e of page.elements ?? []) {
		const b = elementBounds(e, measure);
		boxes.push({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });
	}
	return boxes;
}

/** The plan of showing `next` of the PDF page (`source` pt) on `page`, with the page's items counted; null when the page has no PDF background. */
export function planPageView(page: Page, source: { width: number; height: number }, next: PdfView | undefined, measure: MeasureText = estimateMeasure): PdfViewPlan | null {
	return planPdfView(page, source, next, pageContentBoxes(page, measure));
}

/**
 * Where every stroke and element of `page` goes under `m` (a quarter turn and a translation). Strokes turn with the page, and so do
 * pictures, boxes, markers and areas; text boxes, equations, graphs, sticky notes and checkboxes (which have no rotated form) only move their
 * centre to where it would go and keep their size and orientation, and the ink written on them moves with them by the same translation.
 */
export function pdfViewPlacement(page: Page, m: Matrix, measure: MeasureText = estimateMeasure): Placement {
	const p = emptyPlacement();
	const elements = page.elements ?? [];
	const owned = inkOwnership(page, [], elements, measure, true);
	const moves = new Map<PageElement, Matrix>();
	for (const e of elements) {
		if (!rotationKeepsOrientation(e)) {
			p.elements.set(e, m);
			continue;
		}
		const b = elementBounds(e, measure);
		const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
		const [nx, ny] = apply(m, cx, cy);
		const t = translate(nx - cx, ny - cy);
		moves.set(e, t);
		p.elements.set(e, t);
	}
	for (const s of page.strokes) {
		const owner = owned.owner.get(s);
		p.strokes.set(s, (owner && moves.get(owner)) ?? m);
	}
	return p;
}

/**
 * Turns and/or crops the PDF background of a page as `plan` says (`planPageView`): the new background, size and margins, and every item
 * carried by `plan.matrix`. Undo puts back the very same stroke and element objects, the comments and states lists and the exact previous
 * size, margins and background. Page time stamps are not touched (nothing was written).
 */
export class SetPdfView implements Command {
	readonly label = "Rotate or crop PDF page";
	private readonly moved = new Map<Stroke | PageElement, Stroke | PageElement>();
	private readonly original = new Map<Stroke | PageElement, Stroke | PageElement>();
	private previous: {
		background: PageBackground | undefined; width: number; height: number; margins: PageMargins | undefined;
		states: PageStates | undefined; comments: PageComment[] | undefined;
	} | null = null;
	private after: { states: PageStates | undefined; comments: PageComment[] | undefined } | null = null;

	constructor(
		readonly pageId: string,
		readonly plan: Pick<PdfViewPlan, "background" | "width" | "height" | "margins" | "matrix">,
		/** What the step is called in the history panel. */
		readonly kind: "rotate" | "crop" = "rotate",
		private readonly measure: MeasureText = estimateMeasure,
	) {}

	apply(doc: NotebookDocument): void {
		const page = findPage(doc, this.pageId);
		if (!page) throw new Error(`page ${this.pageId} not found`);
		const plan = this.plan;
		this.previous = { background: page.background, width: page.width, height: page.height, margins: page.margins, states: page.states, comments: page.comments };
		// The items first: the placement depends on the page as it was.
		if (!isIdentity(plan.matrix)) {
			if (this.moved.size === 0) this.compute(page);
			const strokes = page.strokes;
			for (let i = 0; i < strokes.length; i++) strokes[i] = (this.moved.get(strokes[i]!) as Stroke | undefined) ?? strokes[i]!;
			const els = page.elements;
			if (els) for (let i = 0; i < els.length; i++) els[i] = (this.moved.get(els[i]!) as PageElement | undefined) ?? els[i]!;
		}
		page.background = { ...plan.background };
		page.width = plan.width;
		page.height = plan.height;
		if (plan.margins) page.margins = { ...plan.margins };
		else delete page.margins;
		if (!isIdentity(plan.matrix)) {
			if (this.after === null) {
				const states = page.states ? transformStates(page.states, plan.matrix) : undefined;
				const comments = page.comments ? transformComments(page.comments, plan.matrix, { width: plan.width, height: plan.height }) : undefined;
				this.after = { states, comments };
			}
			if (page.states && this.after.states) page.states = this.after.states;
			if (page.comments && this.after.comments) page.comments = this.after.comments;
		}
	}

	private compute(page: Page): void {
		const placement = pdfViewPlacement(page, this.plan.matrix, this.measure);
		for (const [s, m] of placement.strokes) {
			if (isIdentity(m)) continue;
			const next = freezeStroke(transformStroke(s, m));
			this.moved.set(s, next);
			this.original.set(next, s);
		}
		for (const [e, m] of placement.elements) {
			if (isIdentity(m)) continue;
			const next = freezeElement(transformElement(e, m, this.measure));
			this.moved.set(e, next);
			this.original.set(next, e);
		}
	}

	revert(doc: NotebookDocument): void {
		const prev = this.previous;
		if (!prev) return;
		this.previous = null;
		const page = findPage(doc, this.pageId);
		if (!page) throw new Error(`page ${this.pageId} not found`);
		if (prev.background) page.background = prev.background;
		else delete page.background;
		page.width = prev.width;
		page.height = prev.height;
		if (prev.margins) page.margins = prev.margins;
		else delete page.margins;
		if (this.after) {
			if (page.states === this.after.states && prev.states) page.states = prev.states;
			if (page.comments === this.after.comments && prev.comments) page.comments = prev.comments;
		}
		const strokes = page.strokes;
		for (let i = 0; i < strokes.length; i++) {
			const o = this.original.get(strokes[i]!);
			if (o) strokes[i] = o as Stroke;
		}
		const els = page.elements;
		if (els) {
			for (let i = 0; i < els.length; i++) {
				const o = this.original.get(els[i]!);
				if (o) els[i] = o as PageElement;
			}
		}
	}

	remap(swap: ElementSwap): void {
		const pairs = [...this.moved];
		this.moved.clear();
		this.original.clear();
		for (const [o, m] of pairs) {
			const from = swapItem(o, swap);
			const to = swapItem(m, swap);
			this.moved.set(from, to);
			this.original.set(to, from);
		}
	}
}
