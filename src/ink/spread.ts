import type { Layout, PageBox } from "./layout";
import { PAGE_GAP } from "./layout";
import type { ScrollMode } from "./page-mode";
import { PAGE_MARGIN, type Size, type Viewport } from "./viewport";

/**
 * Two-page spread (0.27, #49). Pages are shown in pairs side by side, like an open book, and the pairs are scrolled
 * vertically one under the other. Pure geometry: no 'obsidian', no DOM. The layout only moves page boxes in document
 * space; strokes stay in the page coordinates of the page they are on (a stroke started on one page never reaches the
 * other: the view routes a contact by `pageAt` and converts every sample with that page's box).
 *
 * Rows: with `firstAlone` the first page sits alone on the right (a book's recto) and the pairs are 2-3, 4-5, ...;
 * without it the pairs are 1-2, 3-4, ... An odd page left over sits alone on the left. A one-page notebook is just
 * that page. The binding line is the same on every row, so pages of different widths line up on both sides of it;
 * pages of different heights (portrait next to landscape, PDF pages) are aligned by their top.
 */

/** Gap between the two pages of a pair (pt). Wider than twice the contact tolerance, so no point is ambiguous. */
export const SPREAD_GAP_H = 24;
/** The view must be at least this wide (CSS px) and not taller than it is wide to show a spread; narrower views show one page. */
export const SPREAD_MIN_WIDTH = 720;

export interface SpreadOptions {
	/** The first page alone on the right, like a book. Default: yes. */
	firstAlone: boolean;
	gapH?: number;
	gapV?: number;
}

export const DEFAULT_SPREAD: SpreadOptions = { firstAlone: true };

/** The page indices of each row, in reading order (left, right). */
export function spreadRows(count: number, firstAlone: boolean): number[][] {
	const rows: number[][] = [];
	let i = 0;
	if (firstAlone && count > 1) {
		rows.push([0]);
		i = 1;
	}
	for (; i < count; i += 2) rows.push(i + 1 < count ? [i, i + 1] : [i]);
	return rows;
}

/**
 * The pages in pairs, in document space. `width` is the whole spread (left slot, gap, right slot), `height` the
 * stacked rows. A page alone on its row sits in the slot it would have in a pair (first page: right; last page of an
 * odd count: left), unless the notebook has a single page.
 */
export function layoutSpread(pages: ReadonlyArray<{ width: number; height: number }>, options: SpreadOptions = DEFAULT_SPREAD): Layout {
	const gapH = options.gapH ?? SPREAD_GAP_H;
	const gapV = options.gapV ?? PAGE_GAP;
	const n = pages.length;
	if (n === 0) return { boxes: [], width: 0, height: 0, rows: [] };
	if (n === 1) {
		const p = pages[0]!;
		return { boxes: [{ x: 0, y: 0, width: p.width, height: p.height }], width: p.width, height: p.height, rows: [[0]] };
	}
	const rows = spreadRows(n, options.firstAlone);
	// Which slot each page takes: a pair is (left, right); a lone first page is right, a lone last page is left.
	const slotOf = (row: readonly number[], k: number): "left" | "right" => (row.length === 2 ? (k === 0 ? "left" : "right") : row[0] === 0 && options.firstAlone ? "right" : "left");
	let leftW = 0;
	let rightW = 0;
	for (const row of rows) {
		row.forEach((index, k) => {
			const w = pages[index]!.width;
			if (slotOf(row, k) === "left") leftW = Math.max(leftW, w);
			else rightW = Math.max(rightW, w);
		});
	}
	// A slot nobody uses (all pages alone on one side, e.g. two pages with the first alone) still keeps the binding.
	const boxes: PageBox[] = new Array<PageBox>(n);
	let y = 0;
	for (const row of rows) {
		let rowH = 0;
		row.forEach((index, k) => {
			const p = pages[index]!;
			const left = slotOf(row, k) === "left";
			boxes[index] = { x: left ? leftW - p.width : leftW + gapH, y, width: p.width, height: p.height };
			rowH = Math.max(rowH, p.height);
		});
		y += rowH + gapV;
	}
	return { boxes, width: leftW + gapH + rightW, height: y - gapV, rows };
}

/** The row (page indices, reading order) that page `index` is in; just the page for a layout without rows. */
export function rowOf(layout: Layout, index: number): readonly number[] {
	if (index < 0 || index >= layout.boxes.length) return [];
	return layout.rows?.find((r) => r.includes(index)) ?? [index];
}

/** The other page of the pair that page `index` is in, or -1 (alone on its row, or no spread). */
export function mateOf(layout: Layout, index: number): number {
	const row = rowOf(layout, index);
	return row.length === 2 ? row[0] === index ? row[1]! : row[0]! : -1;
}

/**
 * The page "next" and "previous" go to: `delta` rows away, to the first page of that row (a spread turns by pair). In a
 * layout without pairs it is just the page `delta` away. Clamped to the pages that exist.
 */
export function stepRow(layout: Layout, index: number, delta: number): number {
	const n = layout.boxes.length;
	if (n === 0) return 0;
	const rows = layout.rows;
	if (!rows || !isSpreadLayout(layout)) return Math.min(n - 1, Math.max(0, index + delta));
	const r = rows.findIndex((row) => row.includes(index));
	const target = Math.min(rows.length - 1, Math.max(0, (r < 0 ? 0 : r) + delta));
	return rows[target]![0]!;
}

/** Is the layout a spread (some row holds more than one page)? */
export function isSpreadLayout(layout: Layout): boolean {
	return layout.rows?.some((r) => r.length > 1) ?? false;
}

/** Does a view this size have room for a spread? (Landscape tablet or desktop; a phone or a portrait pane shows one page.) */
export function canSpread(view: Size): boolean {
	return view.width >= SPREAD_MIN_WIDTH && view.width >= view.height;
}

/**
 * The scroll mode actually used. The setting `spread` gives a spread where the view has room for one, a single
 * column elsewhere. `auto` (the "automatic in landscape" setting) does the same for `continuous`. `pages` is never
 * overridden: a reader who asked for one page at a time gets it.
 */
export function effectiveScrollMode(setting: ScrollMode, auto: boolean, view: Size): ScrollMode {
	if (setting === "pages") return "pages";
	if (setting === "spread" || auto) return canSpread(view) ? "spread" : "continuous";
	return "continuous";
}

/** Page under the screen point `(sx, sy)` with the point in that page's coordinates, or null (tolerance in pt, as `pageAt`). */
export function pageUnderScreen(layout: Layout, v: Viewport, sx: number, sy: number, tolerance = 0): { index: number; x: number; y: number } | null {
	const dx = (sx - v.offsetX) / v.scale;
	const dy = (sy - v.offsetY) / v.scale;
	if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
	const index = layout.boxes.findIndex((b) => dx >= b.x - tolerance && dx <= b.x + b.width + tolerance && dy >= b.y - tolerance && dy <= b.y + b.height + tolerance);
	const box = layout.boxes[index];
	return box ? { index, x: dx - box.x, y: dy - box.y } : null;
}

/**
 * The viewport that shows page `index` from its top (or with page y `y` at the top of the view). Vertically the row's
 * top goes to the margin; sideways the view stays put as long as the page is under the middle of the view, otherwise
 * (zoomed in on the other page of the pair, or on another row) the page is centred. Fit zoom needs no sideways move:
 * the spread is centred by the clamp. The caller clamps the result.
 */
export function scrollToPageViewport(layout: Layout, v: Viewport, view: Size, index: number, y = 0, margin = PAGE_MARGIN): Viewport {
	const box = layout.boxes[index];
	if (!box) return v;
	const offsetY = y > 0 ? -(box.y + y) * v.scale : margin - box.y * v.scale;
	if (!isSpreadLayout(layout)) return { ...v, offsetY };
	const left = box.x * v.scale + v.offsetX;
	const right = left + box.width * v.scale;
	const middle = view.width / 2;
	if (left <= middle && right >= middle) return { ...v, offsetY };
	// Only when the spread is wider than the view does a page need bringing in; otherwise it is centred anyway.
	if (layout.width * v.scale + 2 * margin <= view.width) return { ...v, offsetY };
	return { ...v, offsetY, offsetX: middle - (box.x + box.width / 2) * v.scale };
}
