import { quantizePoint } from "./document";
import { freezeElement, freezeStroke } from "./serialize";
import type { Page, PageElement, PageMargins, Stroke } from "./types";

/** Box of the page in which the background (PDF page or scan) is drawn, in page coordinates (pt). */
export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export const NO_MARGINS: Readonly<PageMargins> = Object.freeze({ left: 0, right: 0, bottom: 0 });

/** Largest margin on one side, as a multiple of the background width (or height for the bottom). */
export const MAX_MARGIN_RATIO = 4;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function marginsOf(page: { margins?: PageMargins }): PageMargins {
	const m = page.margins;
	return m ? { left: m.left, right: m.right, bottom: m.bottom } : { ...NO_MARGINS };
}

export function marginsEqual(a: PageMargins | undefined, b: PageMargins | undefined): boolean {
	const x = a ?? NO_MARGINS;
	const y = b ?? NO_MARGINS;
	return x.left === y.left && x.right === y.right && x.bottom === y.bottom;
}

/** Margins rounded to 0.01 pt and clamped at 0; undefined when all three are 0 (no margins is stored as absence). */
export function normalizeMargins(m: PageMargins | undefined): PageMargins | undefined {
	if (!m) return undefined;
	const side = (n: number) => (Number.isFinite(n) && n > 0 ? round2(n) : 0);
	const out = { left: side(m.left), right: side(m.right), bottom: side(m.bottom) };
	return out.left === 0 && out.right === 0 && out.bottom === 0 ? undefined : out;
}

/** Where the background is drawn: the page minus its margins (the whole page without margins). */
export function backgroundRect(page: { width: number; height: number; margins?: PageMargins }): Rect {
	const m = page.margins;
	if (!m) return { x: 0, y: 0, width: page.width, height: page.height };
	return {
		x: m.left,
		y: 0,
		width: Math.max(1, page.width - m.left - m.right),
		height: Math.max(1, page.height - m.bottom),
	};
}

/** Page size once `after` replaces the current margins, the background box keeping its size. */
export function sizeWithMargins(page: { width: number; height: number; margins?: PageMargins }, after: PageMargins | undefined): { width: number; height: number } {
	const box = backgroundRect(page);
	const a = after ?? NO_MARGINS;
	return { width: round2(box.width + a.left + a.right), height: round2(box.height + a.bottom) };
}

/** Same stroke moved by `dx` pt horizontally (same id, points quantized like the file), frozen. */
export function translateStroke(stroke: Stroke, dx: number): Stroke {
	return freezeStroke({ ...stroke, points: stroke.points.map(([x, y, p]) => quantizePoint(x + dx, y, p)) });
}

/** Same element moved by `dx` pt horizontally (same id), frozen. */
export function translateElement<T extends PageElement>(element: T, dx: number): T {
	return freezeElement({ ...element, x: round2(element.x + dx) });
}

/**
 * Margins after resizing a page that has margins, keeping the background box where and as large as it is:
 * the change in width goes to the right margin and the change in height to the bottom one. When the new
 * size is smaller than the box, the box shrinks (the margin on that side becomes 0); when the page would
 * be narrower than the left margin, the margins are dropped and the background fills the page again.
 */
export function marginsAfterResize(page: { width: number; height: number; margins?: PageMargins }, size: { width: number; height: number }): PageMargins | undefined {
	const m = page.margins;
	if (!m) return undefined;
	const box = backgroundRect(page);
	if (size.width - m.left < 1) return undefined;
	return normalizeMargins({
		left: m.left,
		right: Math.max(0, size.width - m.left - box.width),
		bottom: Math.max(0, size.height - box.height),
	});
}

/** Pages that show the same PDF (or image) as `page`, in document order; just `page` when it has no background. */
export function pagesWithSameBackground(pages: readonly Page[], page: Page): Page[] {
	const bg = page.background;
	if (!bg) return [page];
	return pages.filter((p) => p.background?.kind === bg.kind && p.background.asset === bg.asset);
}
