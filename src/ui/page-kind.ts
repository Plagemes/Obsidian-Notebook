// 0.14 generative UI (392): what kind of page is in view, for the toolbar that adapts to it. Pure: no DOM, no 'obsidian'.
// The kind is derived from things already stored (background, paper, size): nothing is added to the document.
import type { PaperKind } from "../model/types";

export const PAGE_KINDS = ["slide", "pdf", "image", "ruled", "grid", "plain"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** Paper with writing lines: the pen and the text box are the tools. */
const RULED: readonly PaperKind[] = ["ruled", "cornell", "calligraphy"];
/** Paper with a square, dotted or triangular lattice: the ruler and the shapes are the tools. */
const GRID: readonly PaperKind[] = ["grid", "dotted", "millimetre", "isometric", "hexagonal"];

/** A PDF page at least this much wider than tall (4:3 is 1.33, 16:9 is 1.78, A4 landscape is 1.41) is read as a slide. */
export const SLIDE_MIN_RATIO = 1.3;

export interface PageKindInput {
	background: "none" | "pdf" | "image";
	paper: PaperKind;
	width: number;
	height: number;
}

/** The kind of a page: the background wins over the paper; landscape PDF pages are slides. */
export function pageKindOf(p: PageKindInput): PageKind {
	if (p.background === "pdf") return p.height > 0 && p.width / p.height >= SLIDE_MIN_RATIO ? "slide" : "pdf";
	if (p.background === "image") return "image";
	if (RULED.includes(p.paper)) return "ruled";
	if (GRID.includes(p.paper)) return "grid";
	return "plain";
}
