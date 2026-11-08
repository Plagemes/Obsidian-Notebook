/** Notebook document format. Units: typographic points (pt), origin at the top-left of the page. */

export const FORMAT_ID = "obsidian-notebook";
/**
 * v21: saved views (#264): the optional notebook-level `views` list (a name, a page and the region of it that was in view, with the zoom).
 * v20: new pens (#35): the tools "fountain", "brush" and "marker" (always written with render 2) and the optional `Stroke.nib` (nib angle in degrees
 * of the fountain pen and the marker; absent = 45).
 * v19: start and end time of a page (#217): the optional `Page.startAt` / `Page.endAt` (ms since 1970).
 * v18: groups and locked elements (#39): the optional `group` of strokes and elements, and the `locked` flag (with `lockAt`) of elements.
 * v17: handwritten checklists (#103): the page element "checkbox" (a drawn square that is tapped to tick it; optional link to an Obsidian task).
 * v16: margin comments (#86): `Page.comments` anchors comments, with their replies, to regions of a page.
 * v15: sticky notes (#20): coloured notes on the page (page elements with typed text; ink written on a note belongs to it).
 * v14: a finished page can be locked (#124): `Page.locked` makes the page refuse every edit until it is unlocked.
 * v13: drawings with states (#241): `Page.states` groups strokes into parts and keeps, per state, where each part is.
 * v12: ink remembers the slide shown beside the notes while it was written (`slides`, `Stroke.slide`, #226).
 * v11: notebook description and generated or image cover (`meta.description`, `meta.coverArt`). v10: anchored excerpts (page elements that show a region of a page and jump back to it). v9: equations (LaTeX,
 * typeset with Obsidian's MathJax) and function graphs (page elements). v8: markers and structured boxes (page elements), hidden ("invisible ink") strokes. v7: bookmark details
 * (title, colour, category), page tags, the shared reading position and more paper kinds (v6: page margins
 * around a background; v5: per-stroke render version; v4: library metadata, assets, backgrounds, elements,
 * infinite pages, "shape" tool; v3: paper kinds and page sizes).
 */
export const CURRENT_VERSION = 21;
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
	/** ISO B5, 176 × 250 mm (a preset only: pages store their size, so adding one is no format change). */
	b5: { width: 498.9, height: 708.66 },
} as const;
export type PageSizeName = keyof typeof PAGE_SIZES;

/** [x, y, pressure] in page coordinates; pressure in [0, 1]. */
export type Point = [number, number, number];

/** v2 adds "highlighter" (translucent, constant width); v4 adds "shape" (constant width, for geometric shapes). */
export const TOOLS = ["pen", "highlighter", "shape", "fountain", "brush", "marker"] as const;
export type Tool = (typeof TOOLS)[number];

/**
 * v20 (#35): the pens that exist only from format v20. They are drawn by the wet-ink geometry only (render 2): a stroke of one of
 * them is never written with render 1, and a file of an older format that has one was not written by any version of this plugin.
 */
export const TOOLS_V20: readonly Tool[] = ["fountain", "brush", "marker"];
export function isNewPen(tool: Tool): boolean {
	return tool === "fountain" || tool === "brush" || tool === "marker";
}
/** v20: the pens whose width follows the direction of the stroke relative to a nib (and so carry a nib angle). */
export function isNibPen(tool: Tool): boolean {
	return tool === "fountain" || tool === "marker";
}

/** v20: the pens people write with (the pen and the new pens); the highlighter and the shape tool are not handwriting. */
export function isWritingPen(tool: Tool): boolean {
	return tool === "pen" || tool === "fountain" || tool === "brush" || tool === "marker";
}
/**
 * v20: the pens whose strokes are lines of handwriting for the features that read writing as lines (ghost guide lines, scribble
 * to erase): the pen, the fountain pen and the brush. The marker is a highlighting tool even though it is drawn in stroke order,
 * so a marker zig-zag over ink never erases it and marking does not move the guides.
 */
export function isLinePen(tool: Tool): boolean {
	return tool === "pen" || tool === "fountain" || tool === "brush";
}
/** v20: nib angle, whole degrees in [0, 179] (the nib is a line: 180° is the same as 0°), counter-clockwise on the page; absent = 45. */
export const NIB_DEFAULT = 45;
export const NIB_MAX = 179;
export function isNibAngle(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= NIB_MAX;
}

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
	/**
	 * v12 (#226): id of the entry of `NotebookDocument.slides` (the slide shown beside the notes) in view when the stroke
	 * was written. Written only when present and only while that entry exists (ink pasted from another notebook loses it).
	 */
	slide?: string;
	/**
	 * v18 (#39): the id of the group of the page the stroke belongs to (see `ElementFlags.group`). Written only when the group has
	 * at least two members on the page; a group with fewer is dissolved on read and on write.
	 */
	group?: string;
	/**
	 * v20 (#35): angle of the nib of a fountain pen or a marker, whole degrees in [0, 179], counter-clockwise on the page (45 is a nib that
	 * leans like a "/"). The width of the line follows the direction of the stroke relative to it. Written only when it is set; absent = 45.
	 * Only those two tools have one.
	 */
	nib?: number;
	points: Point[];
}

/**
 * v12 (#226): one page of one PDF that was shown beside the notes (side by side) while ink was written. `source` is the
 * content-addressed id of the PDF (like `PdfRef.source` of the side-by-side links and the ids of PDF assets), `page` is
 * 1-based, `path` the vault path of a plain PDF (a hint to open it again, and to recognise it after it was replaced in
 * place). `id` is short and unique within the document; strokes refer to it (`Stroke.slide`). Entries no stroke refers
 * to are not written.
 */
export interface SlideRef {
	id: string;
	source: string;
	page: number;
	path?: string;
}

/** v12: longest slide reference id, characters (new ids have 8 base-36 characters). */
export const SLIDE_ID_MAX = 16;
/** v12: longest PDF source id and longest vault path of a slide reference, characters. */
export const SLIDE_SOURCE_MAX = 200;
export const SLIDE_PATH_MAX = 1024;

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

/**
 * v18 (#39): the flags every page element can carry. `group`: the id of the group the element belongs to (absent: none). A
 * group is a set of at least two strokes and elements of ONE page that carry the same id there (the id is scoped to the page:
 * the same id on two pages is two groups); selecting one member selects all of them, so they move, resize, copy and delete as one.
 * `locked`: the element is fixed in place (written only when true): the lasso, a tap and the area eraser skip it, so it cannot be
 * moved, resized, restyled, erased or deleted until it is unlocked (ink over it is unaffected). `lockAt`: when it was last locked
 * or unlocked (ms since 1970; written only once it was): the later decision wins when two copies of a notebook are merged.
 */
export interface ElementFlags {
	group?: string;
	locked?: true;
	lockAt?: number;
}

/** v18: longest group id, characters (new ids are UUIDs, 36 characters). */
export const GROUP_ID_MAX = 64;

/** v4 text box: `x`, `y` top-left, `width` wraps the text; height follows the content. */
export interface TextElement extends ElementFlags {
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
export interface ImageElement extends ElementFlags {
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
export interface MarkerElement extends ElementFlags {
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
export interface BoxElement extends ElementFlags {
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
export interface EquationElement extends ElementFlags {
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
export interface GraphElement extends ElementFlags {
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
export interface ExcerptElement extends ElementFlags {
	id: string;
	type: "excerpt";
	x: number;
	y: number;
	width: number;
	height: number;
	source: ExcerptSource;
	asset?: string;
}

/**
 * v15 sticky note (#20): a coloured note on the page, the box `width` × `height` whose top-left corner is (`x`, `y`) (page
 * coordinates, pt). `color` is its base colour (`#rrggbb`, one of the subject palette; the paper of the note is a light tint
 * of it). `text`: what was typed on it (absent: none), `fontSize` its size (pt). Ink written on the note is ordinary ink of the
 * page that the note owns geometrically (like ink on a picture: ink/attach.ts) and that moves and scales with it.
 *
 * `collapsed`: the note is shown as a small icon at its top-left corner. Its ink is hidden meanwhile and `ink` lists the ids of
 * the strokes that were on the note when it was collapsed (written only while collapsed): the note keeps owning exactly those
 * strokes, so ink written later over the empty place of a collapsed note is not hidden and does not move with the icon. Expanding
 * the note shows its ink again and clears the list. Ids of strokes that are gone are ignored (and not written).
 */
export interface StickyElement extends ElementFlags {
	id: string;
	type: "sticky";
	x: number;
	y: number;
	width: number;
	height: number;
	color: string;
	text?: string;
	fontSize: number;
	collapsed?: true;
	ink?: string[];
}

/**
 * v17 link of a checkbox to a task line of an Obsidian note (#103): the vault `path` of the note and the block id `block`
 * (`nb-…`, without the `^`) that the plugin wrote at the end of the line. Only the line that ends with that block id is ever changed.
 */
export interface CheckboxTask {
	path: string;
	block: string;
}

/**
 * v17 handwritten checkbox (#103): the square `size` pt on a side whose top-left corner is (`x`, `y`) (page coordinates, pt), drawn
 * in `color`. A tap ticks it. `checked`: ticked (written only when ticked). `at`: when it was last ticked or unticked (ms since
 * 1970; written only once it has been toggled): the later toggle wins when two copies of a notebook are merged. `label`: a typed
 * name of the item (shown in lists; the ink on the same line to its right is its handwritten label, found geometrically,
 * ink/checklist.ts). `task`: the link to a task line of a note (absent: none). A copy of a checkbox never keeps the link.
 * `taskAt`: when the link was last set or removed (ms since 1970; written only once it was): the later
 * decision wins when two copies are merged, so an unlinked checkbox is not linked again by an older copy.
 */
export interface CheckboxElement extends ElementFlags {
	id: string;
	type: "checkbox";
	x: number;
	y: number;
	size: number;
	color: string;
	checked?: true;
	at?: number;
	taskAt?: number;
	label?: string;
	task?: CheckboxTask;
}

export type PageElement = TextElement | ImageElement | MarkerElement | BoxElement | EquationElement | GraphElement | ExcerptElement | StickyElement | CheckboxElement;
/** Element types that exist only from format v8: an older file that uses one was not written by this plugin. */
export const ELEMENT_TYPES_V8: readonly string[] = ["marker", "box"];
/** Element types that exist only from format v9. */
export const ELEMENT_TYPES_V9: readonly string[] = ["equation", "graph"];
/** Element types that exist only from format v10. */
export const ELEMENT_TYPES_V10: readonly string[] = ["excerpt"];
/** Element types that exist only from format v15. */
export const ELEMENT_TYPES_V15: readonly string[] = ["sticky"];
/** Element types that exist only from format v17. */
export const ELEMENT_TYPES_V17: readonly string[] = ["checkbox"];

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
	/** v13 (#241): parts of the drawing and the states they move between. Written only when there is a live part. */
	states?: PageStates;
	/**
	 * v14 (#124): the page is locked, a finished page that refuses every edit (ink, eraser, selection changes, text, elements,
	 * paste, states, paper, size, margins, background, deletion) until it is unlocked. Written only when true; locking and
	 * unlocking are ordinary undoable commands (`SetPageLocked`). Reading, navigation, export, copy-out and search work.
	 */
	locked?: true;
	/**
	 * v16 (#86): margin comments: a flat list of comments anchored to regions of this page, each followed anywhere in the list by
	 * its replies (a reply names its comment in `parent`). Written only when not empty. Ordinary undoable commands change it
	 * (`SetPageComments`), so a locked page refuses comment edits like every other edit.
	 */
	comments?: PageComment[];
	/**
	 * v19 (#217): when the first ink or element was added to this page (ms since 1970), and `endAt`, when the last one was. Both are
	 * written together or not at all (`endAt >= startAt`, see model/page-times.ts). They are upkeep, not edits: they are stamped by the
	 * history when a command adds ink or an element, never undone, and a duplicated page or a template page starts without them. They
	 * are the time base that audio recorded with a page will be laid against (M5).
	 */
	startAt?: number;
	endAt?: number;
}

/** A region of a page, in page coordinates (pt): the box whose top-left corner is (`x`, `y`). */
export interface CommentRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * v16: a small handwritten sketch kept inside a comment (not page ink): strokes as flat `[x0, y0, x1, y1, …]` integer lists
 * in the fixed frame `COMMENT_SKETCH_W` × `COMMENT_SKETCH_H`, drawn in the colour of the comment text.
 */
export interface CommentSketch {
	strokes: number[][];
}

/**
 * v16 (#86): a comment anchored to a region of the page. `text` is typed (may be empty when there is a `sketch`). `author` is
 * the name of the device that wrote it, `created` / `edited` are times (ms since 1970); the latest edit wins when two copies of
 * a notebook are merged (`edited`, else `created`). `resolved` is a flag of the thread. Replies are separate list items
 * (`CommentReply`) that name this comment.
 */
export interface PageCommentNote {
	id: string;
	region: CommentRegion;
	text: string;
	sketch?: CommentSketch;
	author: string;
	created: number;
	edited?: number;
	resolved?: true;
}

/** v16: a reply in the flat thread of a comment (`parent` is that comment's id; a reply never has replies of its own). */
export interface CommentReply {
	id: string;
	parent: string;
	text: string;
	author: string;
	created: number;
	edited?: number;
}

export type PageComment = PageCommentNote | CommentReply;

/** v16 limits (the strict writer and the readers share them). */
export const COMMENTS_MAX = 1000;
export const COMMENT_TEXT_MAX = 4000;
export const COMMENT_AUTHOR_MAX = 60;
export const COMMENT_ID_MAX = 40;
export const COMMENT_MIN_SIDE = 4;
export const COMMENT_SKETCH_W = 400;
export const COMMENT_SKETCH_H = 200;
export const COMMENT_SKETCH_STROKES = 40;
export const COMMENT_SKETCH_POINTS = 400;
export const COMMENT_SKETCH_TOTAL = 3000;

/**
 * v13 (#241): a part of a drawing with states: a group of strokes of the page (a block, a force arrow, a spring) that the
 * states of the page move together. `items` are stroke ids of this page (a stroke belongs to one part); `pivot` is the
 * point (page coordinates, fixed when the part was made) that rotation and scale turn around. The strokes keep their
 * own points: a state is a transform applied when the page is drawn or exported, never to the ink itself.
 */
export interface StatePart {
	id: string;
	name?: string;
	pivot: [number, number];
	items: string[];
}

/**
 * v13: where one part is in one state, relative to how it was drawn. Every field but `part` is written only when it
 * differs from the drawn part: `dx`/`dy` move it (pt), `rot` turns it (degrees, clockwise on the page), `scale` scales it
 * (and its line width), `hidden` does not draw it, `color` draws it in that colour (`#rrggbb`).
 */
export interface PartPose {
	part: string;
	dx?: number;
	dy?: number;
	rot?: number;
	scale?: number;
	hidden?: true;
	color?: string;
}

/** v13: a named arrangement of the parts. A part without a pose in a state is where it was drawn. */
export interface PageState {
	id: string;
	name: string;
	poses: PartPose[];
}

/**
 * v13: the states of one page. The drawing itself (the strokes as written) is always available as "Drawn" and is not an
 * entry of `list`; `active` is the state the page shows (and exports); absent = Drawn.
 */
export interface PageStates {
	parts: StatePart[];
	list: PageState[];
	active?: string;
}

/** v13 limits (the strict writer and the readers share them). */
export const STATES_MAX_PARTS = 64;
export const STATES_MAX_STATES = 32;
export const STATES_MAX_ITEMS = 5000;
export const STATES_NAME_MAX = 60;
export const STATES_ID_MAX = 16;
export const STATES_MAX_SHIFT = 100000;
export const STATES_MAX_ROT = 3600;
export const STATES_MIN_SCALE = 0.01;
export const STATES_MAX_SCALE = 100;

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
	/** v11: a short description shown in the library (trimmed, at most META_DESCRIPTION_MAX characters). Written only when not empty. */
	description?: string;
	/** v11: what the cover shows on top of the colour `cover`. Absent = the plain colour cover of before. Written only when present. */
	coverArt?: CoverArt;
}

/** v11: longest notebook description, in characters. */
export const META_DESCRIPTION_MAX = 500;

/** v11: the generated art families of a cover (the names of `ArtStyle` in ui/art/generative-art.ts). */
export const COVER_ART_STYLES = ["contours", "cells", "waves", "branches", "flow", "orbits", "grid"] as const;
export type CoverArtStyle = (typeof COVER_ART_STYLES)[number];

/**
 * v11 cover. `art`: line art generated from `seed` in the style `style`, in the colour `meta.cover` (deterministic: the
 * same three values give the same picture on every device). `image`: an image asset of the document (`doc.assets`,
 * kind "image"), copied into `_assets/` like a page image.
 */
export type CoverArt =
	| { kind: "art"; style: CoverArtStyle; seed: string }
	| { kind: "image"; asset: string };

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

/** v21: most saved views a notebook holds, longest name (characters, after trimming) and longest view / page id. */
export const VIEWS_MAX = 100;
export const VIEW_NAME_MAX = 80;
export const VIEW_ID_MAX = 64;
export const VIEW_PAGE_ID_MAX = 200;
/** v21: the zoom of a saved view is relative to the fit-to-width scale of its page (1 = the page fills the width). */
export const VIEW_ZOOM_MIN = 0.01;
export const VIEW_ZOOM_MAX = 100;
/** v21: largest absolute value of a region coordinate or size, pt. */
export const VIEW_COORD_LIMIT = 1e6;

/**
 * v21 (#264): a named place in the notebook that is recalled in one step. Everything is in page coordinates (pt, origin at the top-left of
 * the page), never screen coordinates, so it means the same on any device.
 * - `page`: the id of the page. A view whose page is gone stays in the list (shown as missing, it can be removed; a page that comes back
 *   with the same id, e.g. from the trash, makes it work again).
 * - `x`, `y`, `width`, `height`: the region of the page that was in view (top-left corner and size).
 * - `zoom`: the scale relative to the fit-to-width scale (1 = the page fills the width), so it survives another screen size.
 * Recalling puts the middle of the region in the middle of the view at that zoom: the same place on the screen it was saved on, and the same
 * part of the page on any other.
 */
export interface SavedView {
	id: string;
	name: string;
	page: string;
	x: number;
	y: number;
	width: number;
	height: number;
	zoom: number;
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
	/** v12 (#226): the slides strokes refer to (`Stroke.slide`). Written only when a stroke refers to one. */
	slides?: SlideRef[];
	/** v21 (#264): the saved views, in the order the list shows them. Written only when there is one; edited only through `SetViews` (model/views.ts), which replaces the array. */
	views?: SavedView[];
	/** v4: assets referenced by pages, keyed by Asset.id. */
	assets?: Record<string, Asset>;
}
