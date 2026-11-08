import { createId } from "./document";
import type { BBox } from "../ink/hit-test";
import type { AreaElement, Page, PageElement } from "./types";

/**
 * Area highlighter (0.25, roadmap #99, format v23). Pure data and geometry: no 'obsidian', no DOM. A drag with the highlighter in its
 * "Area" mode becomes a page element (`AreaElement`): a translucent axis-aligned rectangle in a highlighter colour, drawn above the
 * background and below all the ink. See docs/architecture.md, *Area highlighter, format v23*.
 */

/** An area is never thinner than this (pt): anything smaller is a tap, not a drag. */
export const AREA_MIN_SIDE = 2;
/** The largest side the format accepts (pt); far beyond any page, it only bounds corrupt values. */
export const AREA_MAX_SIDE = 20000;

const round2 = (v: number) => Math.round(v * 100) / 100;

export function isArea(el: PageElement): el is AreaElement {
	return el.type === "area";
}

/** Areas of a page, in array order (the last is drawn on top). */
export function areasOf(page: Pick<Page, "elements">): AreaElement[] {
	return (page.elements ?? []).filter(isArea);
}

/** The box of the area. */
export function areaBounds(el: AreaElement): BBox {
	return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
}

/**
 * The rectangle of a drag from corner `a` to corner `b`, kept inside a page of `page` size, or null when it is too small to be an area
 * (a tap or a stray touch). Coordinates are rounded to 0.01 pt like every element.
 */
export function areaRect(
	a: readonly [number, number], b: readonly [number, number], page: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
	const clampX = (v: number) => Math.min(page.width, Math.max(0, v));
	const clampY = (v: number) => Math.min(page.height, Math.max(0, v));
	const x0 = clampX(Math.min(a[0], b[0]));
	const x1 = clampX(Math.max(a[0], b[0]));
	const y0 = clampY(Math.min(a[1], b[1]));
	const y1 = clampY(Math.max(a[1], b[1]));
	const width = round2(x1 - x0);
	const height = round2(y1 - y0);
	if (!(width >= AREA_MIN_SIDE) || !(height >= AREA_MIN_SIDE)) return null;
	return { x: round2(x0), y: round2(y0), width, height };
}

/** A new area from a drag, or null when the drag is too small. */
export function createArea(
	a: readonly [number, number], b: readonly [number, number], page: { width: number; height: number }, color: string,
): AreaElement | null {
	const r = areaRect(a, b, page);
	return r ? { id: createId(), type: "area", ...r, color } : null;
}

/** The same area in another colour. */
export function withAreaColour(el: AreaElement, color: string): AreaElement {
	return { ...el, color };
}
