import type { NewPageContent, PageContentChange, PageContentPlan } from "../model/page-content";
import { freezeStroke } from "../model/serialize";
import type { PageElement, Stroke } from "../model/types";
import { elementBounds, transformElement, type MeasureText } from "./elements";
import { strokeBounds, type BBox } from "./hit-test";
import { growForInfinite } from "./infinite";
import { transformStroke } from "./lasso";
import { estimateMeasure } from "./text-layout";
import { translate } from "./transform";

/** Insert or remove space never creates more than this many pages. */
export const MAX_SPACE_PAGES = 20;
/** Changes smaller than this (pt) are ignored. */
export const MIN_SPACE_PT = 0.5;

/** What the planner needs of a page (a `Page` fits). */
export interface SpacePage {
	id: string;
	width: number;
	height: number;
	infinite?: boolean;
	/** A PDF or image page: ink annotates that page, so it never moves onto or off another page. */
	background?: unknown;
	strokes: readonly Stroke[];
	elements?: readonly PageElement[];
}

export interface SpacePlan extends PageContentPlan {
	/** The space actually inserted (> 0) or removed (< 0), pt; can be less than asked when removing. */
	delta: number;
}

interface Item {
	stroke?: Stroke;
	element?: PageElement;
	/** Page (index) it is on, its index in that page's array, and its vertical extent in "stacked" coordinates. */
	page: number;
	index: number;
	minY: number;
	maxY: number;
}

export interface SpaceMove {
	item: Item;
	/** Page index it lands on; an index above `endIdx` is a page that does not exist yet. */
	target: number;
	/** Vertical translation in page coordinates (differs from `delta` when it changes page). */
	dy: number;
}

/** Which items move where for a given drag; shared by the live preview and the final plan. */
export interface SpaceAnalysis {
	/** The distance actually applied (limited when removing). */
	delta: number;
	/** Last existing page of the cascade; new pages are inserted right after it. */
	endIdx: number;
	/** The last page of the cascade is infinite: it grows instead of overflowing. */
	grows: boolean;
	staying: Item[];
	moves: SpaceMove[];
	offset: ReadonlyMap<number, number>;
}

/** Items to draw shifted while dragging. `pageIndex` -1: the page does not exist yet (the items are only hidden). */
export interface SpacePreviewEntry {
	pageIndex: number;
	strokes: Stroke[];
	elements: PageElement[];
	dy: number;
}

/**
 * Decides what an insert or remove of `delta` pt at height `y` of page `pageIndex` moves, and where.
 *
 * The notebook is treated as pages stacked without gaps, starting at the top of `pageIndex`. Everything
 * whose centre is below the line (on that page) and every item of the following pages of the cascade
 * moves by `delta`: down when inserting (what no longer fits on its page continues at the top of the
 * next one; new pages are inserted right after the last page of the cascade when needed, same size and
 * paper, no background), up when removing. Items keep their x, ids and order.
 *
 * The cascade only runs over pages without a PDF or image background, because ink there annotates one
 * specific page: a background page never receives content from another page and never gives any up
 * (overflow from it, or from the plain page before it, goes to a new blank page inserted next to it, and
 * removing never pulls content across it). An infinite page also ends the cascade: it grows instead.
 *
 * Removing only takes away empty space: `delta` is limited to the gap between the content that stays and
 * the content that moves, so ink never overlaps.
 *
 * Returns null when nothing would move (nothing below the line, no room to remove, a change under 0.5 pt).
 */
export function analyseSpace(
	pages: readonly SpacePage[], pageIndex: number, y: number, delta: number,
	measure: MeasureText = estimateMeasure, boundsOf: (s: Stroke) => BBox = strokeBounds,
): SpaceAnalysis | null {
	const first = pages[pageIndex];
	if (!first || !Number.isFinite(y) || !Number.isFinite(delta) || Math.abs(delta) < MIN_SPACE_PT) return null;

	let endIdx = pageIndex;
	if (!first.background && !first.infinite) {
		while (endIdx + 1 < pages.length && !pages[endIdx + 1]!.background) {
			endIdx++;
			if (pages[endIdx]!.infinite) break;
		}
	}
	const grows = !!pages[endIdx]!.infinite;
	const lastHeight = pages[endIdx]!.height;
	const heightOf = (i: number) => (i <= endIdx ? pages[i]!.height : lastHeight);

	// Offsets of the pages from the top of `pageIndex`.
	const offset = new Map<number, number>();
	let acc = 0;
	for (let i = pageIndex; i <= endIdx; i++) {
		offset.set(i, acc);
		acc += pages[i]!.height;
	}

	const moving: Item[] = [];
	const staying: Item[] = [];
	let stayBottom = 0;
	let movingTop = Infinity;
	const take = (item: Item) => {
		const centre = (item.minY + item.maxY) / 2;
		if (item.page > pageIndex || centre >= y) {
			moving.push(item);
			movingTop = Math.min(movingTop, item.minY);
		} else {
			staying.push(item);
			stayBottom = Math.max(stayBottom, item.maxY);
		}
	};
	for (let i = pageIndex; i <= endIdx; i++) {
		const base = offset.get(i)!;
		pages[i]!.strokes.forEach((stroke, index) => {
			const b = boundsOf(stroke);
			take({ stroke, page: i, index, minY: base + b.minY, maxY: base + b.maxY });
		});
		pages[i]!.elements?.forEach((element, index) => {
			const b = elementBounds(element, measure);
			take({ element, page: i, index, minY: base + b.minY, maxY: base + b.maxY });
		});
	}
	if (moving.length === 0) return null;

	let d = delta;
	if (delta < 0) d = -Math.min(-delta, Math.max(0, movingTop - stayBottom));
	d = Math.round(d * 100) / 100;
	if (Math.abs(d) < MIN_SPACE_PT) return null;

	// Where does a moved item land? Page index (above endIdx: a new page) and that page's offset.
	const locate = (abs: number): { page: number; offset: number } | null => {
		let j = pageIndex;
		let o = 0;
		for (;;) {
			if (abs < o + heightOf(j) || (grows && j >= endIdx)) return { page: j, offset: o };
			if (j >= endIdx + MAX_SPACE_PAGES) return null;
			o += heightOf(j);
			j++;
		}
	};

	const moves: SpaceMove[] = [];
	for (const item of moving) {
		const land = locate((item.minY + item.maxY) / 2 + d);
		if (!land) return null;
		moves.push({ item, target: land.page, dy: d - (land.offset - offset.get(item.page)!) });
	}
	return { delta: d, endIdx, grows, staying, moves, offset };
}

/** The moving items grouped by the page they land on and by how far they move: what the renderer draws while dragging. */
export function spacePreview(a: SpaceAnalysis): SpacePreviewEntry[] {
	const groups = new Map<string, SpacePreviewEntry>();
	for (const m of a.moves) {
		const pageIndex = m.target > a.endIdx ? -1 : m.target;
		const key = `${pageIndex}:${m.dy}`;
		let g = groups.get(key);
		if (!g) groups.set(key, (g = { pageIndex, strokes: [], elements: [], dy: m.dy }));
		if (m.item.stroke) g.strokes.push(m.item.stroke);
		else g.elements.push(m.item.element!);
	}
	return [...groups.values()];
}

/** Builds the content changes for an analysis. Pure: apply the result with `pageContentCommand`. */
export function planSpaceChange(
	pages: readonly SpacePage[], pageIndex: number, y: number, delta: number,
	measure: MeasureText = estimateMeasure, boundsOf: (s: Stroke) => BBox = strokeBounds,
): SpacePlan | null {
	const a = analyseSpace(pages, pageIndex, y, delta, measure, boundsOf);
	if (!a) return null;
	const { endIdx, grows, offset } = a;

	type Entry<T> = { source: number; index: number; item: T };
	const targets = new Map<number, { strokes: Array<Entry<Stroke>>; elements: Array<Entry<PageElement>> }>();
	const bucket = (j: number) => {
		let b = targets.get(j);
		if (!b) targets.set(j, (b = { strokes: [], elements: [] }));
		return b;
	};
	const touched = new Set<number>();
	for (const it of a.staying) {
		const b = bucket(it.page);
		if (it.stroke) b.strokes.push({ source: it.page, index: it.index, item: it.stroke });
		else b.elements.push({ source: it.page, index: it.index, item: it.element! });
	}
	let grownMaxY = -Infinity;
	for (const { item: it, target, dy } of a.moves) {
		const b = bucket(target);
		touched.add(it.page);
		touched.add(target);
		if (it.stroke) {
			const moved = dy === 0 ? it.stroke : freezeStroke(transformStroke(it.stroke, translate(0, dy)));
			b.strokes.push({ source: it.page, index: it.index, item: moved });
		} else {
			const moved = dy === 0 ? it.element! : transformElement(it.element!, translate(0, dy), measure);
			b.elements.push({ source: it.page, index: it.index, item: moved });
		}
		if (grows && target === endIdx) grownMaxY = Math.max(grownMaxY, it.maxY - offset.get(it.page)! + dy);
	}

	const order = <T>(j: number, entries: Array<Entry<T>>): T[] =>
		entries
			.sort((x, z) => (x.source === j ? 0 : 1) - (z.source === j ? 0 : 1) || x.source - z.source || x.index - z.index)
			.map((e) => e.item);

	const changes: PageContentChange[] = [];
	for (let j = pageIndex; j <= endIdx; j++) {
		if (!touched.has(j)) continue;
		const b = bucket(j);
		const change: PageContentChange = {
			pageId: pages[j]!.id,
			strokes: order(j, b.strokes),
			elements: b.elements.length > 0 ? order(j, b.elements) : undefined,
		};
		if (grows && j === endIdx && grownMaxY > -Infinity) {
			const page = pages[j]!;
			const height = growForInfinite({ width: page.width, height: page.height, infinite: true }, { maxY: grownMaxY });
			if (height !== null) change.height = height;
		}
		changes.push(change);
	}

	const appended: NewPageContent[] = [];
	const lastTarget = Math.max(endIdx, ...targets.keys());
	for (let j = endIdx + 1; j <= lastTarget; j++) {
		const b = bucket(j);
		appended.push({ strokes: order(j, b.strokes), elements: order(j, b.elements) });
	}
	return { delta: a.delta, changes, appended, insertAt: endIdx + 1 };
}
