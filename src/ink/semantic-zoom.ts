/**
 * Semantic zoom (roadmap #130): when the notebook is zoomed far out, the headings and the titles of excerpts, pictures,
 * bookmarks and PDF sections are shown large over the pages, so the overview says what is where. This is the pure part:
 * given the zoom, the page boxes and the label sources, it decides which labels are shown, how big, where, and which one a
 * tap hits. Pure: no DOM, no 'obsidian'; nothing here touches the document, the stroke pipeline or the level of detail of
 * the strokes (`ink/lod.ts` is a different thing).
 *
 * Cost model, for a tablet: the layout of all the labels is computed once per zoom band (a band is a 18 % step of the zoom)
 * and kept in document space, so panning only translates it and a zoom inside a band only scales it. Collision avoidance
 * works inside one page (a label never leaves its page), so it is quadratic in the labels of one page, which are capped.
 * The per-frame step (`visibleLabels`) fills a reusable pool and allocates nothing.
 */
import type { Layout, PageBox } from "./layout";
import { fitWidth, MIN_SCALE, type Size, type Viewport } from "./viewport";

export type SemanticKind = "heading" | "bookmark" | "document" | "section" | "excerpt" | "image";

/** What a label says about its place. 1 is the most important (it is placed first and is never dropped for lack of room). */
export type SemanticLevel = 1 | 2 | 3;

/** Something worth a label, anchored on a page. Rectangles are in page coordinates (pt). */
export interface SemanticSource {
	/** Stable between builds of the same document (it keys the DOM element and the picture). */
	key: string;
	kind: SemanticKind;
	level: SemanticLevel;
	/** 0-based. */
	pageIndex: number;
	x: number;
	y: number;
	width: number;
	height: number;
	/** A text label. */
	text?: string;
	/** A picture label (the ink of a heading): width over height of the picture. */
	aspect?: number;
	/** A picture label: the ids of the strokes the picture shows. */
	ink?: readonly string[];
}

/** A label with its place in document space (pt) at the scale of its zoom band. */
export interface PlacedLabel {
	source: SemanticSource;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Height of the text, CSS px at the band's scale (0 for a picture label). */
	font: number;
}

export interface SemanticLayout {
	band: number;
	/** The scale the sizes were worked out for. */
	scale: number;
	/** Sorted by `y`. */
	labels: PlacedLabel[];
	/** Largest label height (pt), for the binary search of the visible ones. */
	maxHeight: number;
}

/** A label on the screen (CSS px relative to the stage). The pool of these is reused by every frame. */
export interface ScreenLabel {
	label: PlacedLabel | null;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Text size (CSS px) at the current zoom. */
	font: number;
}

// --- when the overlay shows ---

/** The overlay starts to appear below this zoom relative to the fit-to-width zoom, and is complete from `FULL_RATIO`. */
export const SEMANTIC_ON_RATIO = 0.62;
export const SEMANTIC_FULL_RATIO = 0.42;

/**
 * The scales between which the overlay fades in, for a view whose fit-to-width scale is `fit`. On a phone the fit scale
 * is small (about 0.6), so the zoom the user can reach (`MIN_SCALE`) bounds the end of the fade from below: the overlay
 * is complete a little above the smallest zoom, never out of reach.
 */
export function semanticRange(fit: number): { on: number; full: number } {
	const full = Math.max(MIN_SCALE * 1.3, fit * SEMANTIC_FULL_RATIO);
	const on = Math.max(full * 1.35, fit * SEMANTIC_ON_RATIO);
	return { on, full };
}

/** Opacity of the overlay, 0 to 1, for a zoom: 0 at the fit-to-width zoom and above, 1 when zoomed far out; smooth in between. */
export function semanticAlpha(scale: number, fit: number): number {
	if (!(scale > 0) || !(fit > 0)) return 0;
	const { on, full } = semanticRange(fit);
	const t = Math.min(1, Math.max(0, (on - scale) / (on - full)));
	return t * t * (3 - 2 * t);
}

/** Below this opacity the overlay is not drawn and cannot be tapped. */
export const SEMANTIC_MIN_ALPHA = 0.04;
/** Above this opacity a tap on a label counts. */
export const SEMANTIC_TAP_ALPHA = 0.4;

// --- bands ---

/** The zoom steps by this factor between bands. */
export const BAND_STEP = 1.18;

export function bandOf(scale: number): number {
	return Math.round(Math.log(Math.max(1e-6, scale)) / Math.log(BAND_STEP));
}

export function bandScale(band: number): number {
	return BAND_STEP ** band;
}

// --- sizes ---

/** Height of a picture label, CSS px, never smaller / larger than this by level; and the text size by level. */
const PICTURE_PX: Record<SemanticLevel, [number, number]> = { 1: [30, 52], 2: [24, 40], 3: [18, 28] };
const FONT_PX: Record<SemanticLevel, number> = { 1: 20, 2: 16, 3: 13 };
/** A text label is this × its font tall (padding included) and wider than its text by this × the font. */
const TEXT_HEIGHT = 1.75;
const TEXT_PAD = 1.3;
/** Average width of a character over its font size (a Latin sans-serif), when the caller has no better measure. */
const CHAR_WIDTH = 0.58;
/** Space kept between two labels, CSS px. */
const GAP_PX = 6;
/** Most labels on one page by level (1 first): an overview is not a table of contents. */
export const MAX_LABELS_PER_PAGE = 6;
/** A label is at most this wide, CSS px, and at most this share of the view. */
const MAX_WIDTH_PX = 360;
const MAX_WIDTH_VIEW = 0.72;

export type MeasureText = (text: string, fontPx: number) => number;

export const estimateTextWidth: MeasureText = (text, fontPx) => text.length * CHAR_WIDTH * fontPx;

export interface LayoutInput {
	sources: readonly SemanticSource[];
	layout: Layout;
	view: Size;
	band: number;
	measure?: MeasureText;
}

const byImportance = (a: SemanticSource, b: SemanticSource): number =>
	a.level - b.level || a.pageIndex - b.pageIndex || a.y - b.y || a.x - b.x || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

interface Rect { x: number; y: number; width: number; height: number }

function overlaps(a: Rect, b: Rect, gap: number): boolean {
	return a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
}

/**
 * The labels of a band: sizes for the band's scale, then placed most important first. A label is centred on the line of its
 * anchor (or on its top for a tall one), starts at the anchor's left edge and stays inside its page; when it collides with a
 * label already placed it moves up or down by whole label heights, and when no room is found within two steps it is dropped.
 */
export function layoutBand(input: LayoutInput): SemanticLayout {
	const { layout, view, band } = input;
	const measure = input.measure ?? estimateTextWidth;
	const s = bandScale(band);
	const maxW = Math.min(MAX_WIDTH_PX, Math.max(80, view.width * MAX_WIDTH_VIEW));
	const gap = GAP_PX / s;
	const sorted = input.sources.slice().sort(byImportance);
	const perPage = new Map<number, number>();
	const placed = new Map<number, Rect[]>();
	const out: PlacedLabel[] = [];
	let maxHeight = 0;
	for (const src of sorted) {
		const box = layout.boxes[src.pageIndex];
		if (!box || box.width <= 0 || box.height <= 0) continue;
		const count = perPage.get(src.pageIndex) ?? 0;
		if (count >= MAX_LABELS_PER_PAGE) continue;
		const size = sizeOf(src, s, maxW, measure);
		if (!size) continue;
		// In pt of the document at the band's scale; never wider than the page.
		let w = size.width / s;
		let h = size.height / s;
		let font = size.font;
		if (w > box.width) {
			const k = box.width / w;
			w *= k;
			h *= k;
			font *= k;
		}
		if (h > box.height) continue;
		const left = box.x + Math.min(Math.max(0, src.x), Math.max(0, box.width - w));
		const anchorMid = src.height <= h * 1.5 ? src.y + src.height / 2 : src.y + h / 2;
		const list = placed.get(src.pageIndex) ?? [];
		let rect: Rect | null = null;
		for (const step of [0, 1, -1, 2, -2]) {
			const top = box.y + Math.min(Math.max(0, anchorMid - h / 2 + step * (h + gap)), box.height - h);
			const cand = { x: left, y: top, width: w, height: h };
			if (!list.some((r) => overlaps(cand, r, gap))) {
				rect = cand;
				break;
			}
		}
		if (!rect) continue;
		list.push(rect);
		placed.set(src.pageIndex, list);
		perPage.set(src.pageIndex, count + 1);
		out.push({ source: src, x: rect.x, y: rect.y, width: rect.width, height: rect.height, font });
		maxHeight = Math.max(maxHeight, rect.height);
	}
	out.sort((a, b) => a.y - b.y || a.x - b.x);
	return { band, scale: s, labels: out, maxHeight };
}

/** Size in CSS px at scale `s`, or null when the source has nothing to show. */
function sizeOf(src: SemanticSource, s: number, maxW: number, measure: MeasureText): { width: number; height: number; font: number } | null {
	const [lo, hi] = PICTURE_PX[src.level];
	if (src.aspect !== undefined) {
		if (!(src.aspect > 0) || !(src.height > 0)) return null;
		let height = Math.min(hi, Math.max(lo, src.height * s));
		let width = height * src.aspect;
		if (width > maxW) {
			width = maxW;
			height = width / src.aspect;
		}
		return { width, height, font: 0 };
	}
	const text = src.text?.trim();
	if (!text) return null;
	const font = FONT_PX[src.level];
	const width = Math.min(maxW, measure(text, font) + TEXT_PAD * font * 2);
	return { width, height: font * TEXT_HEIGHT, font };
}

// --- cache ---

/**
 * Keeps the layout of the last band. The key is the identity of the sources and of the page layout (both are replaced when
 * the document changes), the band and the view width, so a pan or a zoom inside a band reuses it and a change rebuilds it.
 */
export class SemanticLayoutCache {
	private last: { sources: readonly SemanticSource[]; layout: Layout; band: number; width: number; value: SemanticLayout } | null = null;
	/** Layouts computed (for tests and the benchmark). */
	computed = 0;

	get(input: LayoutInput): SemanticLayout {
		const l = this.last;
		if (l && l.sources === input.sources && l.layout === input.layout && l.band === input.band && l.width === input.view.width) return l.value;
		const value = layoutBand(input);
		this.computed++;
		this.last = { sources: input.sources, layout: input.layout, band: input.band, width: input.view.width, value };
		return value;
	}

	clear(): void {
		this.last = null;
	}
}

// --- per frame ---

/**
 * Fills `pool` with the labels that intersect the view at the viewport `vp` and returns how many. The pool grows as needed
 * and its objects are reused, so a frame allocates nothing once it is big enough. Labels are in the order of the document.
 */
export function visibleLabels(layout: SemanticLayout, vp: Viewport, view: Size, pool: ScreenLabel[], max = Infinity): number {
	const s = vp.scale;
	const top = -vp.offsetY / s;
	const bottom = (view.height - vp.offsetY) / s;
	const left = -vp.offsetX / s;
	const right = (view.width - vp.offsetX) / s;
	const labels = layout.labels;
	// First label that can reach the view: binary search on the (sorted) top edges.
	let lo = 0;
	let hi = labels.length;
	const from = top - layout.maxHeight;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (labels[mid]!.y < from) lo = mid + 1;
		else hi = mid;
	}
	let n = 0;
	const k = s / layout.scale;
	for (let i = lo; i < labels.length && n < max; i++) {
		const l = labels[i]!;
		if (l.y > bottom) break;
		if (l.y + l.height < top || l.x > right || l.x + l.width < left) continue;
		let slot = pool[n];
		if (!slot) {
			slot = { label: null, x: 0, y: 0, width: 0, height: 0, font: 0 };
			pool.push(slot);
		}
		slot.label = l;
		slot.x = vp.offsetX + l.x * s;
		slot.y = vp.offsetY + l.y * s;
		slot.width = l.width * s;
		slot.height = l.height * s;
		slot.font = l.font * k;
		n++;
	}
	return n;
}

/** The index in the first `count` entries of the label under (x, y) (CSS px, with `slop` around the labels), the one drawn last when they overlap; -1 for none. */
export function hitLabel(pool: readonly ScreenLabel[], count: number, x: number, y: number, slop = 0): number {
	for (let i = count - 1; i >= 0; i--) {
		const l = pool[i]!;
		if (x >= l.x - slop && x <= l.x + l.width + slop && y >= l.y - slop && y <= l.y + l.height + slop) return i;
	}
	return -1;
}

// --- the jump ---

/** Where on the view the line jumped to is put (share of the view height, from the top). */
export const JUMP_TOP_SHARE = 0.22;

/**
 * The viewport after a tap on a label: the page fits the width again (the overlay fades out) and the anchored line sits near the
 * top of the view. The caller clamps it to the pages. Null when the page is not laid out.
 */
export function jumpViewport(layout: Layout, view: Size, src: Pick<SemanticSource, "pageIndex" | "y" | "height">): Viewport | null {
	const box: PageBox | undefined = layout.boxes[src.pageIndex];
	if (!box || view.width <= 0 || view.height <= 0) return null;
	const fit = fitWidth(view, layout);
	const midY = box.y + src.y + Math.min(src.height, 40) / 2;
	return { scale: fit.scale, offsetX: fit.offsetX, offsetY: view.height * JUMP_TOP_SHARE - midY * fit.scale };
}
