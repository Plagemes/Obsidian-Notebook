import { SetPageMargins, SetPageSize, type Command } from "../model/history";
import { A4_HEIGHT, A4_WIDTH, type Page } from "../model/types";

/** An infinite page never grows beyond this multiple of its width. */
export const MAX_INFINITE_RATIO = 20;
/** Growth step as a fraction of a page (a page of the same width with A4 proportions). */
export const INFINITE_STEP = 0.5;

export interface InfinitePage {
	width: number;
	height: number;
	infinite?: boolean;
}

/**
 * New height of an infinite page after ink reached its bottom `margin` (fraction of the height, default the bottom fifth),
 * or null when nothing has to change (not infinite, ink above the margin, or already at the cap of 20 × width).
 * Grows by half a page (width × A4 ratio / 2) as many times as needed to bring the ink out of the margin.
 */
export function growForInfinite(
	page: InfinitePage, bounds: { maxY: number }, margin = 0.2, step = INFINITE_STEP * page.width * (A4_HEIGHT / A4_WIDTH),
): number | null {
	if (!page.infinite || !(step > 0)) return null;
	const cap = MAX_INFINITE_RATIO * page.width;
	let height = page.height;
	if (height >= cap) return null;
	while (bounds.maxY >= height * (1 - margin) && height < cap) height += step;
	height = Math.min(cap, Math.round(height * 100) / 100);
	return height > page.height ? height : null;
}

/**
 * The command that grows `page` to `height` (from `growForInfinite`). Round-3 review (Z3): a page with a background (a PDF page or a
 * picture) and no margins grows by a bottom margin, as a page with margins does through `SetPageSize`: the background keeps its box
 * instead of being stretched down, so it stays under its redaction boxes and the Undo of the writing that grew it is never refused.
 */
export function growCommand(page: Pick<Page, "id" | "width" | "height" | "background" | "margins">, height: number): Command {
	if (page.background && !page.margins) return new SetPageMargins(page.id, undefined, { left: 0, right: 0, bottom: Math.round((height - page.height) * 100) / 100 });
	return new SetPageSize(page.id, { width: page.width, height: page.height }, { width: page.width, height });
}
