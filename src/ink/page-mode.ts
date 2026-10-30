import type { Layout } from "./layout";
import { clampToPage, MAX_SCALE, MIN_SCALE, PAGE_MARGIN, type Size, type Viewport } from "./viewport";

/**
 * Scroll modes (#14). `continuous`: pages stacked vertically, scrolled freely. `pages`: one page at a time, the
 * pages sit side by side and a horizontal swipe turns to the next one. Pure geometry; the DOM side is
 * `view/page-mode.ts`. Strokes stay in page coordinates in both modes: only the page boxes move.
 */
export type ScrollMode = "continuous" | "pages";
export const SCROLL_MODES: readonly ScrollMode[] = ["continuous", "pages"];

/**
 * Gap between pages side by side (pt). At the smallest fit scale it is still wider than the page margin, so the
 * neighbouring page never shows at rest when the current one fills the view.
 */
export const PAGE_GAP_H = 64;

/** Drag past this fraction of the view width turns the page. */
export const TURN_DISTANCE = 0.22;
/** ...or a flick faster than this (CSS px per ms) that travelled at least `TURN_MIN_FLICK` px. */
export const TURN_VELOCITY = 0.45;
export const TURN_MIN_FLICK = 40;
/** A finger must travel this far (CSS px) before the swipe direction is decided. */
export const LOCK_SLOP = 10;
/** Swipe resistance past the first/last page. */
export const EDGE_RESISTANCE = 0.3;
/** Duration of the page-turn animation (ms). */
export const TURN_MS = 220;

export function isScrollMode(v: unknown): v is ScrollMode {
	return v === "continuous" || v === "pages";
}

/** Pages side by side, top aligned, in document space. `width` is the whole row, `height` the tallest page. */
export function layoutPagesHorizontal(pages: ReadonlyArray<{ width: number; height: number }>, gap = PAGE_GAP_H): Layout {
	let x = 0;
	let height = 0;
	const boxes = pages.map((p) => {
		const box = { x, y: 0, width: p.width, height: p.height };
		x += p.width + gap;
		height = Math.max(height, p.height);
		return box;
	});
	return { boxes, width: pages.length ? x - gap : 0, height };
}

/** Layout of the pages for a scroll mode. */
export function layoutForMode(mode: ScrollMode, pages: ReadonlyArray<{ width: number; height: number }>, layoutVertical: (p: typeof pages) => Layout): Layout {
	return mode === "pages" ? layoutPagesHorizontal(pages) : layoutVertical(pages);
}

/** Index of the page nearest to the document x coordinate (0 inside a page, else the closest edge); -1 for no pages. */
export function nearestPageByX(layout: Layout, x: number): number {
	let best = -1;
	let bestDist = Infinity;
	layout.boxes.forEach((b, i) => {
		const d = x < b.x ? b.x - x : x > b.x + b.width ? x - b.x - b.width : 0;
		if (d < bestDist) {
			bestDist = d;
			best = i;
		}
	});
	return best;
}

/**
 * The page `index` as wide as the view allows, centred, aligned to the top. Each page fills the width on its own,
 * so a narrower page never leaves room for its neighbour to peek in at rest (the writing size follows the page
 * size, as in a PDF reader; the continuous mode uses the widest page for every page).
 */
export function fitPageViewport(view: Size, layout: Layout, index: number, margin = PAGE_MARGIN): Viewport {
	const box = layout.boxes[index];
	if (!box || box.width <= 0) return { scale: 1, offsetX: 0, offsetY: margin };
	const usable = Math.max(1, view.width - 2 * margin);
	const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, usable / box.width));
	return { scale, offsetX: (view.width - box.width * scale) / 2 - box.x * scale, offsetY: margin - box.y * scale };
}

/**
 * Keeps the view on page `anchor`: a page narrower than the view stays centred, otherwise its edges cannot move
 * in past the margin (same rules as `clampToPage`, applied to that page's box).
 */
export function clampToAnchor(v: Viewport, view: Size, layout: Layout, anchor: number, margin = PAGE_MARGIN): Viewport {
	const box = layout.boxes[anchor];
	if (!box) return v;
	const local = clampToPage({ scale: v.scale, offsetX: v.offsetX + box.x * v.scale, offsetY: v.offsetY + box.y * v.scale }, view, box, margin);
	return { scale: local.scale, offsetX: local.offsetX - box.x * v.scale, offsetY: local.offsetY - box.y * v.scale };
}

/** Can the page be panned sideways / up and down at this zoom (is it bigger than the view)? */
export function panRoom(v: Viewport, view: Size, layout: Layout, anchor: number, margin = PAGE_MARGIN): { x: boolean; y: boolean } {
	const box = layout.boxes[anchor];
	if (!box) return { x: false, y: false };
	return {
		x: box.width * v.scale + 2 * margin > view.width + 0.5,
		y: box.height * v.scale + 2 * margin > view.height + 0.5,
	};
}

/**
 * Where the view goes when turning from page `from` to page `to` (forward: `to > from`).
 * Fit mode: the next page fitted, at its top. Zoomed in: the same scale and height, at the near edge of the
 * new page (left edge going forward, right edge going back).
 */
export function turnViewport(v: Viewport, view: Size, layout: Layout, from: number, to: number, fit: boolean, margin = PAGE_MARGIN): Viewport {
	if (fit) return clampToAnchor(fitPageViewport(view, layout, to, margin), view, layout, to, margin);
	const box = layout.boxes[to];
	const src = layout.boxes[from];
	if (!box) return v;
	// Same position relative to the page top as before (screen px), clamped to the new page.
	const relY = v.offsetY + (src?.y ?? 0) * v.scale;
	const wide = box.width * v.scale + 2 * margin > view.width;
	const offsetX = to > from
		? (wide ? margin : (view.width - box.width * v.scale) / 2) - box.x * v.scale
		: (wide ? view.width - box.width * v.scale - margin : (view.width - box.width * v.scale) / 2) - box.x * v.scale;
	return clampToAnchor({ scale: v.scale, offsetX, offsetY: relY - box.y * v.scale }, view, layout, to, margin);
}

/** -1 previous page, 0 stay, 1 next page. `drag` is the sideways travel in CSS px (positive: content moved right). */
export function decideTurn(drag: number, velocity: number, viewWidth: number, hasPrev: boolean, hasNext: boolean): -1 | 0 | 1 {
	const far = Math.abs(drag) >= viewWidth * TURN_DISTANCE;
	const flick = Math.abs(velocity) >= TURN_VELOCITY && Math.abs(drag) >= TURN_MIN_FLICK && Math.sign(velocity) === Math.sign(drag);
	if (!far && !flick) return 0;
	if (drag > 0) return hasPrev ? -1 : 0;
	if (drag < 0) return hasNext ? 1 : 0;
	return 0;
}

/**
 * Sideways velocity (CSS px/ms) from the moves in the last `windowMs` before `now` (the lift). A finger that
 * rested before lifting has no velocity.
 */
export function recentVelocity(samples: ReadonlyArray<{ t: number; dx: number }>, now?: number, windowMs = 90): number {
	if (samples.length === 0) return 0;
	const end = samples[samples.length - 1]!.t;
	if (now !== undefined && now - end > windowMs) return 0;
	const recent = samples.filter((s) => end - s.t <= windowMs);
	const first = recent[0]!.t;
	if (recent.length === 1) return recent[0]!.dx / 16;
	// The first sample only marks where the window starts: its own travel happened before it.
	const span = Math.max(16, end - first);
	return recent.slice(1).reduce((a, s) => a + s.dx, 0) / span;
}

export type SwipeAxis = "none" | "x" | "y" | "free";

export interface SwipeContext {
	/** The page is wider than the view: sideways movement pans it (turning needs an overscroll). */
	panX: boolean;
	/** The page is taller than the view: vertical movement scrolls it. */
	panY: boolean;
}

export interface SwipeStep {
	/** Pan to apply to the page now (CSS px). */
	panX: number;
	panY: number;
	/** Sideways travel that drags towards another page now (CSS px). */
	dragX: number;
}

/**
 * Decides what a finger gesture does in page mode: scroll inside the page, drag towards the next page, or
 * (zoomed in, pannable both ways) pan freely. The direction is locked after `LOCK_SLOP` px so a vertical scroll
 * with a slightly crooked finger does not start a page turn.
 */
export class SwipeLock {
	axis: SwipeAxis = "none";
	private sx = 0;
	private sy = 0;

	reset(): void {
		this.axis = "none";
		this.sx = 0;
		this.sy = 0;
	}

	add(dx: number, dy: number, ctx: SwipeContext): SwipeStep {
		const none: SwipeStep = { panX: 0, panY: 0, dragX: 0 };
		if (this.axis === "none") {
			this.sx += dx;
			this.sy += dy;
			if (Math.hypot(this.sx, this.sy) < LOCK_SLOP) return none;
			if (ctx.panX) this.axis = "free";
			else if (!ctx.panY) this.axis = "x";
			else this.axis = Math.abs(this.sx) > Math.abs(this.sy) * 1.6 ? "x" : "y";
			// The movement held back while undecided is applied now, along the chosen axis.
			dx = this.sx;
			dy = this.sy;
		}
		switch (this.axis) {
			case "x": return { panX: 0, panY: 0, dragX: dx };
			case "y": return { panX: 0, panY: ctx.panY ? dy : 0, dragX: 0 };
			default: return { panX: dx, panY: dy, dragX: 0 };
		}
	}
}

/** Resists a drag past the first or last page. */
export function resistDrag(drag: number, hasPrev: boolean, hasNext: boolean): number {
	if (drag > 0 && !hasPrev) return drag * EDGE_RESISTANCE;
	if (drag < 0 && !hasNext) return drag * EDGE_RESISTANCE;
	return drag;
}

export function easeOutCubic(p: number): number {
	const q = 1 - Math.min(1, Math.max(0, p));
	return 1 - q * q * q;
}

export function lerpViewport(a: Viewport, b: Viewport, p: number): Viewport {
	return {
		scale: a.scale + (b.scale - a.scale) * p,
		offsetX: a.offsetX + (b.offsetX - a.offsetX) * p,
		offsetY: a.offsetY + (b.offsetY - a.offsetY) * p,
	};
}
