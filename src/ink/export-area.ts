// 0.23 (#280): export only the written area of a page, or only the selection, as a transparent picture. Pure: the bounding box of
// what is written (visible ink and the elements; never the sheet, the PDF/picture background or the paper), the page cut down to a
// selection, and the plan of one export. The pictures themselves are drawn by the existing renderers (page-raster, export-svg).
import { hiddenStickyInk } from "../model/sticky";
import type { Page, PageElement, Stroke } from "../model/types";
import { withPinnedInk } from "./attach";
import { elementBounds } from "./elements";
import { cropSvg } from "../model/note-insert";
import { strokeBounds, type BBox } from "./hit-test";
import { estimateMeasure, type MeasureText } from "./text-layout";

/** Margin kept around the written area, pt. */
export const AREA_MARGIN = 8;
/** Scales offered for the PNG (pixels per pt multiplier: 1x, 2x, 3x). */
export const AREA_SCALES = [1, 2, 3] as const;
export type AreaScale = (typeof AREA_SCALES)[number];
export const DEFAULT_AREA_SCALE: AreaScale = 2;
export type AreaFormat = "png" | "svg";
export type AreaScope = "page" | "selection";

export interface AreaRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The box around everything that is drawn: the ink that is shown (hidden ink only when `hiddenInk`, never the ink a collapsed
 * sticky note keeps out of view) and every element. Null when the page has nothing to draw.
 */
export function areaBounds(page: Pick<Page, "strokes" | "elements">, hiddenInk = false, measure: MeasureText = estimateMeasure): BBox | null {
	const noteInk = hiddenStickyInk(page.elements);
	const boxes: BBox[] = [];
	for (const s of page.strokes) {
		if ((s.hidden && !hiddenInk) || noteInk?.has(s.id) || s.points.length === 0) continue;
		boxes.push(strokeBounds(s));
	}
	for (const el of page.elements ?? []) boxes.push(elementBounds(el, measure));
	if (boxes.length === 0) return null;
	return boxes.reduce((a, b) => ({
		minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
	}));
}

/** The rectangle of the picture: `bounds` grown by the margin (not cut at the page edge: ink may lie outside it). */
export function areaRect(bounds: BBox, margin: number = AREA_MARGIN): AreaRect {
	const x = bounds.minX - margin;
	const y = bounds.minY - margin;
	return { x, y, width: Math.max(1, bounds.maxX - bounds.minX + 2 * margin), height: Math.max(1, bounds.maxY - bounds.minY + 2 * margin) };
}

/**
 * `page` cut down to the selected strokes and elements (page order kept), plus the ink the selected collapsed notes keep hidden,
 * and without its background: what the picture of a selection draws. The document is not touched.
 */
export function selectionPage(page: Page, strokes: readonly Stroke[], elements: readonly PageElement[]): Page {
	const wantedEls = new Set(elements.map((e) => e.id));
	const wantedInk = new Set(withPinnedInk(page.strokes, strokes, elements).map((s) => s.id));
	const { background: _background, ...rest } = page;
	void _background;
	return { ...rest, strokes: page.strokes.filter((s) => wantedInk.has(s.id)), elements: (page.elements ?? []).filter((e) => wantedEls.has(e.id)) };
}

export interface AreaPlan {
	/** The page to draw (the whole page, or the selection cut out of it). */
	page: Page;
	rect: AreaRect;
}

/** What one export draws; null when there is nothing written (the caller refuses with a notice). */
export function planArea(page: Page, selection: { strokes: readonly Stroke[]; elements: readonly PageElement[] } | null, hiddenInk = false, measure: MeasureText = estimateMeasure): AreaPlan | null {
	const drawn = selection ? selectionPage(page, selection.strokes, selection.elements) : page;
	const bounds = areaBounds(drawn, hiddenInk, measure);
	return bounds ? { page: drawn, rect: areaRect(bounds) } : null;
}

/** The vector picture: the page SVG (ink layer only, so transparent) cut to the rectangle. */
export function areaSvg(svgOfInk: string, rect: AreaRect): string | null {
	return cropSvg(svgOfInk, rect);
}

/** File name part: ` p3 area`, ` p3 selection`. */
export function areaSuffix(pageNumber: number, scope: AreaScope): string {
	return ` p${pageNumber} ${scope === "selection" ? "selection" : "area"}`;
}
