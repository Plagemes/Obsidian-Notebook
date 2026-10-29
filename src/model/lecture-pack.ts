/**
 * Lecture pack page plans (no 'obsidian', no DOM): how the slides of a PDF become notebook pages.
 *
 * Layouts (roadmap #192, #193), all expressed with the v6 page fields that already exist:
 * - `slide`: the page is the slide (what "Import PDF" always did); the student writes on the slide.
 * - `notes-right` / `notes-bottom`: one slide per page. The slide is scaled to a fixed size (so the
 *   handwriting scale is the same whatever the size of the PDF) and the page grows by a right or bottom
 *   margin (`PageMargins`) that holds the notes area. The page has the chosen paper, which shows in
 *   the margin (the background covers only its box).
 * - `notesPageAfter`: a blank page of the same size and the chosen paper after every slide page.
 *
 * Two or three slides on one page are NOT possible without a format change: a page has exactly one
 * `background` (one PDF page), and putting the other slides in as images would turn vector slides into
 * rasters (blurry when zoomed, no text for search, republishing and annotation export). See
 * docs/architecture.md, "Lecture pack".
 */
import { createPdfPages } from "./pages";
import { createPage } from "./document";
import { normalizeMargins } from "./margins";
import { A4_HEIGHT, A4_WIDTH, PAPER_KINDS, PAPER_SPACING, type Asset, type Page, type PageMargins, type PaperKind } from "./types";

export const SLIDE_LAYOUTS = ["slide", "notes-right", "notes-bottom"] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

/** Longer side of a slide scaled for a notes layout, pt: handwriting has the same scale for every course. */
export const REFERENCE_SLIDE_SIDE = 640;
/** Width of the notes area beside the slide, as a multiple of the slide width. */
export const NOTES_RIGHT_RATIO = 0.6;
/** Height of the notes area below the slide, as a multiple of the slide height. */
export const NOTES_BOTTOM_RATIO = 0.8;

export interface LayoutOptions {
	layout: SlideLayout;
	/** Paper of the page when it has a notes area (the slide itself covers its part). Ignored for `slide`. */
	notesPaper: PaperKind;
	/** Add a blank page after every slide page. */
	notesPageAfter: boolean;
	/** Paper of those pages. */
	afterPaper: PaperKind;
}

export const DEFAULT_LAYOUT_OPTIONS: Readonly<LayoutOptions> = Object.freeze({
	layout: "slide",
	notesPaper: "ruled",
	notesPageAfter: false,
	afterPaper: "grid",
});

/** The options as stored (device storage may hold anything): unknown values fall back to the defaults. */
export function parseLayoutOptions(raw: unknown): LayoutOptions {
	const d = DEFAULT_LAYOUT_OPTIONS;
	if (typeof raw !== "object" || raw === null) return { ...d };
	const o = raw as Record<string, unknown>;
	const paper = (v: unknown, fallback: PaperKind): PaperKind => (PAPER_KINDS as readonly unknown[]).includes(v) ? (v as PaperKind) : fallback;
	return {
		layout: (SLIDE_LAYOUTS as readonly unknown[]).includes(o.layout) ? (o.layout as SlideLayout) : d.layout,
		notesPaper: paper(o.notesPaper, d.notesPaper),
		notesPageAfter: typeof o.notesPageAfter === "boolean" ? o.notesPageAfter : d.notesPageAfter,
		afterPaper: paper(o.afterPaper, d.afterPaper),
	};
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface SlideGeometry {
	/** Size of the page. */
	width: number;
	height: number;
	/** Margins around the slide; absent when the slide fills the page. */
	margins?: PageMargins;
}

/** Page size and margins for one slide of size `slide` (pt) in `layout`. */
export function slideGeometry(slide: { width: number; height: number }, layout: SlideLayout): SlideGeometry {
	if (!(Number.isFinite(slide.width) && slide.width > 0 && Number.isFinite(slide.height) && slide.height > 0)) {
		throw new Error("slideGeometry: invalid slide size");
	}
	if (layout === "slide") return { width: slide.width, height: slide.height };
	const scale = REFERENCE_SLIDE_SIDE / Math.max(slide.width, slide.height);
	const boxW = round2(slide.width * scale);
	const boxH = round2(slide.height * scale);
	const margins = normalizeMargins(layout === "notes-right"
		? { left: 0, right: round2(boxW * NOTES_RIGHT_RATIO), bottom: 0 }
		: { left: 0, right: 0, bottom: round2(boxH * NOTES_BOTTOM_RATIO) });
	return { width: round2(boxW + (margins?.right ?? 0)), height: round2(boxH + (margins?.bottom ?? 0)), margins };
}

export interface PlannedPage {
	/** A slide of the PDF, or a blank notes page after one. */
	kind: "slide" | "notes";
	/** Index (0-based) in the list of imported slides. */
	slide: number;
	width: number;
	height: number;
	margins?: PageMargins;
	paper: PaperKind;
}

/** The pages to create for slides of the given sizes, in document order. Pure: no ids, no assets. */
export function planLecturePages(sizes: ReadonlyArray<{ width: number; height: number }>, options: LayoutOptions): PlannedPage[] {
	const plan: PlannedPage[] = [];
	sizes.forEach((size, i) => {
		const g = slideGeometry(size, options.layout);
		const paper: PaperKind = options.layout === "slide" ? "blank" : options.notesPaper;
		plan.push({ kind: "slide", slide: i, width: g.width, height: g.height, margins: g.margins, paper });
		if (options.notesPageAfter) plan.push({ kind: "notes", slide: i, width: g.width, height: g.height, paper: options.afterPaper });
	});
	return plan;
}

/**
 * Pages for PDF pages `firstPage…` of `asset` in the chosen layout. Slide pages show the PDF page; the
 * blank notes pages have no background. The caller adds the asset and the pages in one Batch.
 */
export function buildLecturePackPages(
	asset: Asset,
	sizes: ReadonlyArray<{ width: number; height: number }>,
	firstPage: number,
	options: LayoutOptions,
): Page[] {
	// Validates the asset kind, the first page and the sizes, and sets the backgrounds.
	const slides = createPdfPages(asset, sizes, firstPage);
	return planLecturePages(sizes, options).map((item) => {
		const spacing = PAPER_SPACING[item.paper];
		if (item.kind === "notes") return createPage({ width: item.width, height: item.height }, { kind: item.paper, spacing });
		const page = createPage({ width: item.width, height: item.height }, { kind: item.paper, spacing });
		page.background = { ...slides[item.slide]!.background! };
		if (item.margins) page.margins = { ...item.margins };
		return page;
	});
}

/**
 * "Exercise page here": a blank page with the exercise paper, the size of the page it follows (the full page,
 * margins included, so after a slide with a notes area the exercise page is as wide as that page). A grown
 * infinite page gives an A4-proportioned page of the same width. No background, margins or content.
 */
export function exercisePage(like: { width: number; height: number; infinite?: boolean }, paper: PaperKind): Page {
	const height = like.infinite ? round2(like.width * (A4_HEIGHT / A4_WIDTH)) : like.height;
	return createPage({ width: like.width, height }, { kind: paper, spacing: PAPER_SPACING[paper] });
}
