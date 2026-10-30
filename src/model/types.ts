/** Notebook document format. Units: typographic points (pt), origin at the top-left of the page. */

export const FORMAT_ID = "obsidian-notebook";
/**
 * v10: anchored excerpts (page elements that show a region of a page and jump back to it). v9: equations (LaTeX,
 * typeset with Obsidian's MathJax) and function graphs (page elements). v8: markers and structured boxes (page elements), hidden ("invisible ink") strokes. v7: bookmark details
 * (title, colour, category), page tags, the shared reading position and more paper kinds (v6: page margins
 * around a background; v5: per-stroke render version; v4: library metadata, assets, backgrounds, elements,
 * infinite pages, "shape" tool; v3: paper kinds and page sizes).
 */
export const CURRENT_VERSION = 10;
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
	/**
	 * v8 invisible ink (#100): the stroke is not drawn, exported or erasable until the reader shows the solutions
	 * (a view-only toggle). Written only when true.
	 */
	hidden?: true;
	points: Point[];
}

/**
 * Paper backgrounds. v3 adds "blank" to "millimetre" (v2 had only "grid"); v7 adds "cornell" to "planner-week".
 * `spacing` (pt): line height for ruled and cornell, cell for grid, dot pitch for dotted, minor line
 * (1 mm, a major line every 10) for millimetre, gap between staff lines for music, triangle side for
 * isometric, hexagon side for hexagonal, x-height for calligraphy, row height for the planners; unused
 * for blank. Pattern geometry in ink/paper.ts.
 */
export const PAPER_KINDS = [
	"blank", "ruled", "grid", "dotted", "millimetre",
	"cornell", "music", "isometric", "hexagonal", "calligraphy", "planner-day", "planner-week",
] as const;
export type PaperKind = (typeof PAPER_KINDS)[number];
/** Paper kinds that exist only from format v7: an older file that uses one was not written by this plugin. */
export const PAPER_KINDS_V7: readonly PaperKind[] = ["cornell", "music", "isometric", "hexagonal", "calligraphy", "planner-day", "planner-week"];

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
	cornell: 8 * MM,
	music: 2 * MM,
	isometric: GRID_5MM,
	hexagonal: 4 * MM,
	calligraphy: 6 * MM,
	"planner-day": 8 * MM,
	"planner-week": 6 * MM,
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

/**
 * v8 marker kinds: "gap" a to-complete placeholder (#201), "question" for the lecturer (#202), importance
 * "important" (!), "critical" (!!) and "star" (★) (#203), "homework" with a due date (#209).
 */
export const MARKER_KINDS = ["gap", "question", "important", "critical", "star", "homework"] as const;
export type MarkerKind = (typeof MARKER_KINDS)[number];

/**
 * v8 marker: a small badge whose top-left corner is (`x`, `y`), optionally about a region of the page
 * (`width` × `height` from the same corner; both or neither). Optional fields are written only when present.
 */
export interface MarkerElement {
	id: string;
	type: "marker";
	kind: MarkerKind;
	x: number;
	y: number;
	width?: number;
	height?: number;
	/** When it was placed (ISO time). */
	at?: string;
	/** Resolved question, filled gap, homework done. Only `true` is stored. */
	done?: true;
	/** Gap: 1-based page of the reference PDF (or of the page's own PDF background) in view when it was placed. */
	slide?: number;
	/** Homework: due date `YYYY-MM-DD`. */
	due?: string;
	/** A short label: the question, what the homework is. One line, at most MARKER_TEXT_MAX characters. */
	text?: string;
}

/** v8 structured box kinds (#204). */
export const BOX_KINDS = ["definition", "theorem", "example", "proof", "remark"] as const;
export type BoxKind = (typeof BOX_KINDS)[number];

/** v8 structured box: a labelled frame around a region of the page (drawn under the ink). */
export interface BoxElement {
	id: string;
	type: "box";
	kind: BoxKind;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Optional title shown on the label (and as the callout title in the companion note). Same rules as a marker label. */
	title?: string;
}

/** Longest marker label or box title, characters. */
export const MARKER_TEXT_MAX = 300;

/**
 * v9 equation (#110): LaTeX source typeset with Obsidian's maths engine (MathJax) into the box `width` × `height`
 * whose top-left corner is (`x`, `y`). Optional fields are written only when present.
 */
export interface EquationElement {
	id: string;
	type: "equation";
	x: number;
	y: number;
	width: number;
	height: number;
	/** LaTeX source, without delimiters (no `$`); several lines allowed (`aligned`, `cases`). */
	latex: string;
	/** Size of the typeset maths, pt (the em of MathJax). */
	fontSize: number;
	/** `#rrggbb` */
	color: string;
	/** Inline style (text-style fractions and limits). Absent: display style. */
	inline?: true;
	/** Numbered: "(n)" is drawn at its right, n counting the numbered equations in reading order. */
	numbered?: true;
	/**
	 * Cached vector outline of the typeset glyphs: a path of absolute `M`/`L`/`Z` commands in pt relative to (`x`, `y`),
	 * filled with the even-odd rule. Drawn, exported and converted to ink without MathJax. Absent: typeset when shown.
	 */
	outline?: string;
}

/** v9 kinds of graphed functions (#113). */
export const GRAPH_FUNCTION_KINDS = ["cartesian", "parametric", "polar", "implicit", "piecewise"] as const;
export type GraphFunctionKind = (typeof GRAPH_FUNCTION_KINDS)[number];

/** One piece of a piecewise function: `expr` where `when` holds (absent `when`: everywhere else). */
export interface GraphPiece {
	expr: string;
	when?: string;
}

/**
 * v9 graphed function. Expressions are plain strings for the safe parser in src/math/expr.ts (never eval): cartesian
 * `expr` is y(x); polar `expr` is r(θ); implicit `expr` is `lhs = rhs` (or F(x, y) = 0); parametric `x` and `y` are
 * functions of t; piecewise `pieces` are y(x). `min`/`max`: range of t (parametric) or θ (polar), or a domain
 * restriction of x (cartesian, piecewise). A syntax error in an expression is not a format error: the graph shows it.
 */
export interface GraphFunction {
	/** Unique within the graph. */
	id: string;
	kind: GraphFunctionKind;
	/** `#rrggbb` */
	color: string;
	expr?: string;
	x?: string;
	y?: string;
	pieces?: GraphPiece[];
	min?: number;
	max?: number;
	/** Line width, pt (default GRAPH_LINE_WIDTH). */
	width?: number;
	/** Not drawn (kept with its settings). */
	hidden?: true;
	/** Mark the roots, the maxima and minima, the intersections with the other functions (cartesian and piecewise). */
	roots?: true;
	extrema?: true;
	intersections?: true;
	/** x of a tangent line drawn at (x, f(x)). */
	tangent?: number;
	/** Area between the curve and the x axis, shaded from `from` to `to`, with its value. */
	area?: { from: number; to: number };
	/** Shown in the legend. */
	label?: string;
}

/** v9 parameter of a graph (a slider in the edit panel): a name the expressions use, its value and range. */
export interface GraphParam {
	name: string;
	value: number;
	min: number;
	max: number;
	/** Slider step (absent: continuous). */
	step?: number;
}

/** v9 part of the plane shown by a graph, in graph units. */
export interface GraphViewport {
	xMin: number;
	xMax: number;
	yMin: number;
	yMax: number;
}

/** v9 table of values of one function: `rows` values of x from `from`, `step` apart. */
export interface GraphTable {
	/** Id of the function. */
	fn: string;
	from: number;
	step: number;
	rows: number;
}

/**
 * v9 function graph (#113): a frame `width` × `height` with its top-left corner at (`x`, `y`) showing `view` of the
 * plane. Ink written on it follows its coordinates when it is moved, scaled, panned or zoomed (see ink/graph-ink.ts).
 */
export interface GraphElement {
	id: string;
	type: "graph";
	x: number;
	y: number;
	width: number;
	height: number;
	view: GraphViewport;
	functions: GraphFunction[];
	params?: GraphParam[];
	/** Axes hidden. */
	axes?: false;
	/** Grid hidden. */
	grid?: false;
	/** Grid and tick steps, graph units (absent: chosen from the view). */
	xStep?: number;
	yStep?: number;
	xLabel?: string;
	yLabel?: string;
	/** Trigonometric functions in degrees (absent: radians). */
	degrees?: true;
	table?: GraphTable;
}

/**
 * v10 source of an anchored excerpt (#105): the region (`x`, `y`, `width`, `height`, page coordinates, pt) of the page
 * `page` (stable page id) of the notebook `doc` (NotebookDocument.id), which was at the vault path `notebook` when the
 * excerpt was made. The path finds the file; the document id recognises it after a rename and tells an excerpt of the
 * same notebook apart (drawn live from the open document).
 */
export interface ExcerptSource {
	notebook: string;
	doc: string;
	page: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * v10 anchored excerpt (#105): a region of a page shown in the box `width` × `height` whose top-left corner is
 * (`x`, `y`); tapping its badge jumps back to the source. `asset`: the image asset holding a snapshot of the region
 * taken when it was made (drawn when the source cannot be drawn live, and in exports). Written only when present.
 */
export interface ExcerptElement {
	id: string;
	type: "excerpt";
	x: number;
	y: number;
	width: number;
	height: number;
	source: ExcerptSource;
	asset?: string;
}

export type PageElement = TextElement | ImageElement | MarkerElement | BoxElement | EquationElement | GraphElement | ExcerptElement;
/** Element types that exist only from format v8: an older file that uses one was not written by this plugin. */
export const ELEMENT_TYPES_V8: readonly string[] = ["marker", "box"];
/** Element types that exist only from format v9. */
export const ELEMENT_TYPES_V9: readonly string[] = ["equation", "graph"];
/** Element types that exist only from format v10. */
export const ELEMENT_TYPES_V10: readonly string[] = ["excerpt"];

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
	/** v7: tags of this page (#119): non-empty, without duplicates, in the order they were added. Written only when not empty. */
	tags?: string[];
}

/** Built-in bookmark categories (#85); any other non-empty string is a custom category, shown as is. */
export const BOOKMARK_CATEGORIES = ["important", "review"] as const;

/**
 * v7: details of a bookmark (#15, #85). Every field is optional and written only when present: a bookmark
 * without a title shows the page number, without a colour the accent colour, without a category none.
 */
export interface BookmarkInfo {
	title?: string;
	/** #rrggbb */
	color?: string;
	/** "important", "review" or a custom name. */
	category?: string;
}

/** v4 notebook metadata, shown and edited in the library. */
export interface NotebookMeta {
	tags: string[];
	favorite: boolean;
	/** Cover colour #rrggbb. */
	cover: string;
	/** Bookmarked page ids (which pages are bookmarked; the outline lists them in page order). */
	bookmarks: string[];
	/**
	 * v7: details of bookmarked pages, keyed by page id. Only for ids in `bookmarks` (others are dropped on
	 * read and write); an entry without fields is dropped. Written only when not empty.
	 */
	bookmarkInfo?: Record<string, BookmarkInfo>;
}

/** Metadata of a new notebook and of every migrated v3 file. Never mutate it: copy it (cloneMeta in document.ts). */
export const DEFAULT_META: Readonly<NotebookMeta> = {
	tags: [],
	favorite: false,
	cover: "#3b82f6",
	bookmarks: [],
};

/**
 * v7: where the notebook was last read (#125), so another device can open it there. Updated only by a save
 * that writes content anyway (never a write of its own just for scrolling); last writer wins. Not undoable.
 */
export interface ReadingPosition {
	/** Page id; a position on a page that is not in the document is dropped on read and write. */
	page: string;
	/** Page y (pt) at the top of the view, > 0; absent = the top of the page. */
	y?: number;
	/** When the reader was there (ISO time), to tell which device was there last. */
	at: string;
}

export interface NotebookDocument {
	format: typeof FORMAT_ID;
	version: typeof CURRENT_VERSION;
	id: string;
	createdAt: string;
	modifiedAt: string;
	pages: Page[];
	/** v4 */
	meta?: NotebookMeta;
	/** v7: last reading position. Written only when present. */
	position?: ReadingPosition;
	/** v4: assets referenced by pages, keyed by Asset.id. */
	assets?: Record<string, Asset>;
}
