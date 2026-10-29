import type { NewPageContent, PageContentChange, PageContentPlan } from "../model/page-content";
import { freezeStroke } from "../model/serialize";
import type { PageElement, Stroke } from "../model/types";
import { elementBounds, transformElement, type MeasureText } from "./elements";
import { strokeBounds } from "./hit-test";
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

/**
 * Insert or remove vertical space at height `y` of page `pageIndex`.
 *
 * The notebook is treated as pages stacked without gaps, starting at the top of `pageIndex`. Everything
 * whose centre is below the line (on that page) and every item of the following pages moves by `delta`:
 * down when inserting (what no longer fits on its page continues at the top of the next one, and
 * pages are appended when needed), up when removing. Items keep their x, ids and order; an item
 * that crosses the line stays with the part above if its centre is above it.
 *
 * Removing only takes away empty space: `delta` is limited to the gap between the content that stays
 * and the content that moves, so ink never overlaps. An infinite page ends the cascade: it grows instead
 * of pushing content onto a next page (and the pages after it are not touched).
 *
 * Returns null when nothing would move (nothing below the line, no room to remove, a change under 0.5 pt).
 * Pure: the result is applied with `pageContentCommand`.
 */
export function planSpaceChange(
	pages: readonly SpacePage[], pageIndex: number, y: number, delta: number, measure: MeasureText = estimateMeasure,
): SpacePlan | null {
	const first = pages[pageIndex];
	if (!first || !Number.isFinite(y) || !Number.isFinite(delta) || Math.abs(delta) < MIN_SPACE_PT) return null;
	const stopAt = pages.findIndex((p, i) => i >= pageIndex && !!p.infinite);
	const endIdx = stopAt >= 0 ? stopAt : pages.length - 1;
	const lastPage = pages[pages.length - 1]!;
	const heightOf = (i: number) => (i < pages.length ? pages[i]!.height : lastPage.height);

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
			const b = strokeBounds(stroke);
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

	// Where does a moved item land? Page index (maybe a page that does not exist yet) and that page's offset.
	const locate = (abs: number): { page: number; offset: number } | null => {
		let j = pageIndex;
		let o = 0;
		for (;;) {
			if (abs < o + heightOf(j) || (stopAt >= 0 && j >= endIdx)) return { page: j, offset: o };
			if (j >= pages.length - 1 + MAX_SPACE_PAGES) return null;
			o += heightOf(j);
			j++;
		}
	};

	type Entry<T> = { source: number; index: number; item: T };
	const targets = new Map<number, { strokes: Array<Entry<Stroke>>; elements: Array<Entry<PageElement>> }>();
	const bucket = (j: number) => {
		let b = targets.get(j);
		if (!b) targets.set(j, (b = { strokes: [], elements: [] }));
		return b;
	};
	const touched = new Set<number>();
	for (const it of staying) {
		const b = bucket(it.page);
		if (it.stroke) b.strokes.push({ source: it.page, index: it.index, item: it.stroke });
		else b.elements.push({ source: it.page, index: it.index, item: it.element! });
	}
	const grownMaxY = { value: -Infinity };
	for (const it of moving) {
		const centre = (it.minY + it.maxY) / 2;
		const land = locate(centre + d);
		if (!land) return null;
		const dy = d - (land.offset - offset.get(it.page)!);
		const b = bucket(land.page);
		touched.add(it.page);
		touched.add(land.page);
		let maxLocal: number;
		if (it.stroke) {
			const moved = dy === 0 ? it.stroke : freezeStroke(transformStroke(it.stroke, translate(0, dy)));
			b.strokes.push({ source: it.page, index: it.index, item: moved });
			maxLocal = it.maxY - offset.get(it.page)! + dy;
		} else {
			const moved = dy === 0 ? it.element! : transformElement(it.element!, translate(0, dy), measure);
			b.elements.push({ source: it.page, index: it.index, item: moved });
			maxLocal = it.maxY - offset.get(it.page)! + dy;
		}
		if (land.page === endIdx && stopAt >= 0) grownMaxY.value = Math.max(grownMaxY.value, maxLocal);
	}

	const order = <T>(j: number, entries: Array<Entry<T>>): T[] =>
		entries
			.sort((a, b) => (a.source === j ? 0 : 1) - (b.source === j ? 0 : 1) || a.source - b.source || a.index - b.index)
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
		if (stopAt >= 0 && j === endIdx && grownMaxY.value > -Infinity) {
			const page = pages[j]!;
			const height = growForInfinite({ width: page.width, height: page.height, infinite: true }, { maxY: grownMaxY.value });
			if (height !== null) change.height = height;
		}
		changes.push(change);
	}

	const appended: NewPageContent[] = [];
	const lastTarget = Math.max(...targets.keys());
	for (let j = pages.length; j <= lastTarget; j++) {
		const b = bucket(j);
		appended.push({ strokes: order(j, b.strokes), elements: order(j, b.elements) });
	}
	return { delta: d, changes, appended };
}
