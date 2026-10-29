/** Notebook document format. Units: typographic points (pt), origin at the top-left of the page. */

export const FORMAT_ID = "obsidian-notebook";
/**
 * v6: optional page margins around a background (v5: per-stroke render version; v4: library metadata,
 * assets, backgrounds, elements, infinite pages, "shape" tool; v3: paper kinds and page sizes).
 */
export const CURRENT_VERSION = 6;
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

/** v2 adds "highlighter" (translucent, constant width); v4 adds "shape" (constant width, for geometric shapes). */
export const TOOLS = ["pen", "highlighter", "shape"] as const;
export type Tool = (typeof TOOLS)[number];

/** Geometry that draws a stroke: perfect-freehand outline with the frozen per-tool parameters (every stroke written before v5). */
export const RENDER_FREEHAND = 1;
/** Incremental "wet ink" geometry. */
export const RENDER_INK = 2;
export const RENDER_VERSIONS = [RENDER_FREEHAND, RENDER_INK] as const;
export type RenderVersion = (typeof RENDER_VERSIONS)[number];

export interface Stroke {
	id: string;
	tool: Tool;
	/** `#rrggbb` */
	color: string;
	/** Nominal diameter in pt. */
	width: number;
	/**
	 * v5: which geometry draws the stroke. 1 = perfect-freehand outline with the per-tool parameters
	 * (frozen: every stroke written before v5 is 1 and must keep rendering exactly as before);
	 * 2 = incremental wet-ink geometry.
	 */
	render: RenderVersion;
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

/** v4: content-addressed file in the assets folder (`<notebooks folder>/_assets/<id>.<ext>`). */
export type AssetKind = "pdf" | "image";

export interface Asset {
	/** Content hash (hex), also the file name without extension. */
	id: string;
	kind: AssetKind;
	/** Vault path when the asset was stored; resolved again by id if the file moved. */
	path: string;
	/** Original file name, for display. */
	name: string;
	bytes: number;
}

/** v4: what is drawn under the paper pattern and the ink. */
export type PageBackground =
	| { kind: "pdf"; asset: string; /** 1-based page number in the PDF */ page: number }
	| { kind: "image"; asset: string };

/** v4 text box: `x`, `y` top-left, `width` wraps the text; height follows the content. */
export interface TextElement {
	id: string;
	type: "text";
	x: number;
	y: number;
	width: number;
	text: string;
	fontSize: number;
	color: string;
}

/** v4 image placed on the page, rotation in radians around its centre. */
export interface ImageElement {
	id: string;
	type: "image";
	asset: string;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
}

export type PageElement = TextElement | ImageElement;

/**
 * v6: blank space added around a page's background (a PDF page or a scan), in pt. The background is
 * drawn in the box `x = left, y = 0, width = page.width - left - right, height = page.height - bottom`
 * (backgroundRect in margins.ts); without margins it fills the page. Ink keeps page coordinates:
 * widening to the left moves the background and the ink together (SetPageMargins).
 */
export interface PageMargins {
	left: number;
	right: number;
	bottom: number;
}

export interface Page {
	id: string;
	width: number;
	height: number;
	paper: Paper;
	strokes: Stroke[];
	/** v4 */
	background?: PageBackground;
	/** v4: drawn above the background and below the ink. */
	elements?: PageElement[];
	/** v4: the page grows downwards while writing near its bottom edge. */
	infinite?: boolean;
	/** v6: margins around the background; absent = the background fills the page. Written only when present. */
	margins?: PageMargins;
}

/** v4 notebook metadata, shown and edited in the library. */
export interface NotebookMeta {
	tags: string[];
	favorite: boolean;
	/** Cover colour #rrggbb. */
	cover: string;
	/** Bookmarked page ids. */
	bookmarks: string[];
}

/** Metadata of a new notebook and of every migrated v3 file. Never mutate it: copy it (cloneMeta in document.ts). */
export const DEFAULT_META: Readonly<NotebookMeta> = {
	tags: [],
	favorite: false,
	cover: "#3b82f6",
	bookmarks: [],
};

export interface NotebookDocument {
	format: typeof FORMAT_ID;
	version: typeof CURRENT_VERSION;
	id: string;
	createdAt: string;
	modifiedAt: string;
	pages: Page[];
	/** v4 */
	meta?: NotebookMeta;
	/** v4: assets referenced by pages, keyed by Asset.id. */
	assets?: Record<string, Asset>;
}
