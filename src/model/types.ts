/** Notebook document format. Units: typographic points (pt), origin at the top-left of the page. */

export const FORMAT_ID = "obsidian-notebook";
export const CURRENT_VERSION = 2;
export const FILE_EXTENSION = "notebook";

/** A4 in pt (210 × 297 mm). */
export const A4_WIDTH = 595.28;
export const A4_HEIGHT = 841.89;
/** 5 mm in pt. */
export const GRID_5MM = 14.17;
/** 1 mm in pt. */
export const MM = 2.8346;

/** Page size presets in pt (portrait; landscape swaps width and height). */
export const PAGE_SIZES = {
	a4: { width: A4_WIDTH, height: A4_HEIGHT },
	a5: { width: 419.53, height: A4_WIDTH },
	letter: { width: 612, height: 792 },
} as const;
export type PageSizeName = keyof typeof PAGE_SIZES;

/** [x, y, pressure] in page coordinates; pressure in [0, 1]. */
export type Point = [number, number, number];

/** v2 adds "highlighter" (translucent, constant width). */
export const TOOLS = ["pen", "highlighter"] as const;
export type Tool = (typeof TOOLS)[number];

export interface Stroke {
	id: string;
	tool: Tool;
	/** `#rrggbb` */
	color: string;
	/** Nominal diameter in pt. */
	width: number;
	points: Point[];
}

/**
 * Paper backgrounds. v3 adds everything but "grid".
 * `spacing` (pt): line height for ruled, cell for grid, dot pitch for dotted,
 * minor line (1 mm, a major line every 10) for millimetre; unused for blank.
 */
export const PAPER_KINDS = ["blank", "ruled", "grid", "dotted", "millimetre"] as const;
export type PaperKind = (typeof PAPER_KINDS)[number];

export interface Paper {
	kind: PaperKind;
	spacing: number;
}

/** Default spacing per paper kind, pt. */
export const PAPER_SPACING: Readonly<Record<PaperKind, number>> = {
	blank: GRID_5MM,
	ruled: 8 * MM,
	grid: GRID_5MM,
	dotted: GRID_5MM,
	millimetre: MM,
};

export interface Page {
	id: string;
	width: number;
	height: number;
	paper: Paper;
	strokes: Stroke[];
}

export interface NotebookDocument {
	format: typeof FORMAT_ID;
	version: typeof CURRENT_VERSION;
	id: string;
	createdAt: string;
	modifiedAt: string;
	pages: Page[];
}
