import type { AreaElement, ExcerptElement, Page, PageElement, Point, ShapeDash, Stroke, TextElement, Tool } from "../model/types";
import { isNewPen, MM, RENDER_FREEHAND, RENDER_INK } from "../model/types";
import { opacityOf } from "../model/opacity";
import { strokeTaper, writingTaper } from "../model/taper";
import { backgroundRect } from "../model/margins";
import { transformElement } from "./elements";
import { drawBox, drawMarker, type BoxLabel } from "./marker-render";
import { drawExcerpt, drawExcerptBadge } from "./excerpt-render";
import { hiddenStickyInk } from "../model/sticky";
import { drawSticky } from "./sticky-render";
import { drawCheckbox } from "./checkbox-render";
import { drawArea } from "./area-render";
import { drawEquation, drawGraph, type GraphPalette } from "./math-render";
import { graphClips, strokeClip } from "./attach";
import { equationNumbers } from "../model/math-elements";
import { drawLinkedLines, shownText } from "./link-text";
import { hasFigureTokens, withFigureScope, type FigureLabelSource } from "./figure-text";
import { layoutText, type MeasureText } from "./text-layout";
import { strokeBounds, type BBox } from "./hit-test";
import { memoColors, nightHighlighter, nightInk, nightLine, NIGHT_BACKGROUND_VEIL, NIGHT_HIGHLIGHTER_ALPHA, NIGHT_PAPER } from "./night";
import { minorVisible, paperPattern, PAPER_COLORS } from "./paper";
import { visiblePages, type Layout, type PageBox } from "./layout";
import { rulerEdge, rulerTicks, type Ruler } from "./ruler";
import { inkPath, type InkBuilder } from "./ink-geometry";
import { HIGHLIGHTER_ALPHA, MARKER_ALPHA, strokePath, strokeSvgPath } from "./stroke-shape";
import { fillAlpha, fillPathD, isFilled } from "./shape-style";
import { addLodNodesPath, lodLevel, lodNodes, lodPolygon } from "./lod";
import { LazyWet } from "./lazy-wet";
import { WetInk, wetHiddenAtLift, type PageTransform } from "./wet-ink";
import { ErrorOnce } from "./errors";
import type { SpacePreviewEntry } from "./space";
import type { SnapGuide } from "../model/snap";
import { ghostAlpha, ghostTouchRedraws, GHOST_IDLE_MS, type GhostMode, type GhostSegment } from "../model/ghost-lines";
import { partMatrix, translate, type Matrix } from "./transform";
import type { Viewport } from "./viewport";
import { DIM_ALPHA } from "../model/colour-meaning";

const PAPER = "#ffffff";
const SHADOW = "rgba(0, 0, 0, 0.18)";
const SELECTION = "#2563eb";
/** Snap guides (roadmap #71): alignment with an item, with the page or a margin, and the paper grid. */
const SNAP_GUIDE_ITEM = "#e11d74";
const SNAP_GUIDE_PAGE = "#0d9488";
const SNAP_GUIDE_GRID = "rgba(37, 99, 235, 0.45)";
const PLACEHOLDER = "#f1f5f9";
const PLACEHOLDER_TEXT = "#64748b";

/** Bitmaps the renderer cannot produce itself: PDF pages, scans, images. */
export interface MediaSource {
	/** Best available bitmap for the page background at `deviceScale` (device px per pt), or null while loading. */
	background(page: Page, deviceScale: number): CanvasImageSource | null;
	/** Text shown on the placeholder (e.g. "Loading…" or a missing file name). */
	backgroundLabel(page: Page): string | null;
	image(assetId: string): CanvasImageSource | null;
	/**
	 * v10: the live picture of an excerpt's source region at `deviceScale` (device px per pt), when its source can be
	 * drawn now (a page of the open notebook); null to draw the snapshot instead.
	 */
	excerpt?(el: ExcerptElement, deviceScale: number): CanvasImageSource | null;
	/** v10: the excerpt's source page is known to be gone (its badge is drawn grey). */
	excerptMissing?(el: ExcerptElement): boolean;
}

/** v10: the best picture of an excerpt: live from its source when the media can draw it, else its snapshot. */
export function excerptImage(media: MediaSource | null | undefined, el: ExcerptElement, deviceScale: number): CanvasImageSource | null {
	if (!media) return null;
	return media.excerpt?.(el, deviceScale) ?? (el.asset !== undefined ? media.image(el.asset) : null);
}

/** Draws a text box in page coordinates; used by the renderer, thumbnails and the live layer. */
export function drawTextElement(ctx: CanvasRenderingContext2D, el: TextElement): void {
	ctx.save();
	try {
		ctx.font = `${el.fontSize}px ${TEXT_FONT}`;
		ctx.fillStyle = el.color;
		ctx.textBaseline = "top";
		// A link ([[Note|alias]]) shows its label, not its markup (ink/wikilink.ts); the layout is of what is shown.
		const shown = el.text.includes("[[") || hasFigureTokens(el.text) ? shownText(el.text) : null;
		const layout = layoutText(shown ? shown.text : el.text, el.fontSize, el.width, (str) => ctx.measureText(str).width);
		// Links are drawn in their own colour (ink/link-text.ts); text without any takes the plain path.
		if (shown && shown.links.length > 0) {
			drawLinkedLines(ctx, el, layout.lines, layout.lineHeight, shown);
			return;
		}
		layout.lines.forEach((line, i) => ctx.fillText(line, el.x, el.y + i * layout.lineHeight + (layout.lineHeight - el.fontSize) / 2));
	} finally {
		ctx.restore();
	}
}

/** Font used for text boxes on screen. */
export const TEXT_FONT = "sans-serif";

let measureCtx: CanvasRenderingContext2D | null = null;

/** Text width in pt with the on-screen font (a canvas context shared by everything that lays text out). */
export const measureText: MeasureText = (s, fontSize) => {
	// A detached canvas (0.12.3): `createEl` on a Document appends to the document itself and throws.
	measureCtx ??= createEl("canvas").getContext("2d");
	if (!measureCtx) return Array.from(s).length * fontSize * 0.55;
	measureCtx.font = `${fontSize}px ${TEXT_FONT}`;
	return measureCtx.measureText(s).width;
};

/**
 * Draws one element in page coordinates (images may be rotated; `img` null draws a placeholder). `numbers`: the
 * automatic numbers of numbered equations (v9).
 */
export function drawElement(
	ctx: CanvasRenderingContext2D, el: PageElement, img: CanvasImageSource | null, boxLabel?: BoxLabel, numbers?: ReadonlyMap<string, number>,
): void {
	if (el.type === "text") {
		drawTextElement(ctx, el);
		return;
	}
	if (el.type === "marker") {
		drawMarker(ctx, el);
		return;
	}
	if (el.type === "box") {
		drawBox(ctx, el, boxLabel);
		return;
	}
	if (el.type === "equation") {
		drawEquation(ctx, el, numbers?.get(el.id));
		return;
	}
	if (el.type === "graph") {
		drawGraph(ctx, el);
		return;
	}
	if (el.type === "excerpt") {
		drawExcerpt(ctx, el, img);
		return;
	}
	if (el.type === "sticky") {
		drawSticky(ctx, el);
		return;
	}
	if (el.type === "checkbox") {
		drawCheckbox(ctx, el);
		return;
	}
	if (el.type === "area") {
		drawArea(ctx, el);
		return;
	}
	ctx.save();
	try {
		ctx.translate(el.x + el.width / 2, el.y + el.height / 2);
		if (el.rotation) ctx.rotate(el.rotation);
		// v24 (#358): a picture with an opacity is drawn that strongly (the placeholder too).
		if (el.opacity !== undefined) ctx.globalAlpha *= opacityOf(el);
		if (img) ctx.drawImage(img, -el.width / 2, -el.height / 2, el.width, el.height);
		else {
			ctx.fillStyle = PLACEHOLDER;
			ctx.fillRect(-el.width / 2, -el.height / 2, el.width, el.height);
		}
	} finally {
		ctx.restore();
	}
}

export interface LiveStroke {
	pageIndex: number;
	tool: Tool;
	color: string;
	width: number;
	/** Format v20: the nib angle of a fountain pen or a marker (absent = 45). */
	nib?: number;
	/** Format v22 (#37): the fill colour of a closed shape being drawn, whether it is a tint, and the line style of a dashed or dotted shape. */
	fill?: string;
	fillTint?: true;
	dash?: ShapeDash;
	/** Format v24 (#358): the opacity of the stroke being written (multiplies the pen's alpha; absent = 1). */
	opacity?: number;
	/** Format v25 (#351): the taper of the two ends of the stroke being written (absent = none). */
	taperStart?: number;
	taperEnd?: number;
	points: readonly Point[];
	predicted: readonly Point[];
}

/** Lasso being drawn, in page coordinates. */
export interface LassoOverlay {
	pageIndex: number;
	points: ReadonlyArray<readonly [number, number]>;
}

/** Strokes drawn over a page for a moment and never saved (the "peek at the solution" of a practice copy), page coordinates. */
export interface PeekOverlay {
	pageIndex: number;
	strokes: readonly Stroke[];
}

/** 0.20 (#94): ghost guide lines on blank paper, drawn on the live layer for a moment and never saved or exported. */
export interface GhostOverlay {
	pageIndex: number;
	segments: readonly GhostSegment[];
	mode: GhostMode;
	/** `performance.now()` of the last stroke that ended (the guides fade from here in "writing" mode). */
	since: number;
}
/** Shared dash pattern (no allocation per frame). */
const GHOST_DASH: number[] = [6, 5];
const GHOST_COLOR = "#64748b";
const GHOST_COLOR_NIGHT = "#cbd5e1";
const GHOST_ALPHA = 0.5;

/** Ruler placed on a page, drawn on the live layer (page coordinates). */
export interface RulerOverlay {
	pageIndex: number;
	ruler: Ruler;
}

/** Selected strokes and elements, drawn on the live layer with a transform while they are moved, scaled or rotated. */
export interface SelectionOverlay {
	pageIndex: number;
	strokes: readonly Stroke[];
	elements: readonly PageElement[];
	matrix: Matrix;
	/** Selection bounds in page coordinates, before `matrix`. */
	bounds: BBox;
	/** Handle size in CSS px. */
	handle: number;
	/**
	 * wave 0.10 (359): the items of the other pages of a selection that crosses page boundaries. `offset` is what a point of
	 * that page adds up to in the frame of `pageIndex` (the primary page, the one `matrix` and `bounds` are in).
	 */
	parts?: ReadonlyArray<{ pageIndex: number; strokes: readonly Stroke[]; elements: readonly PageElement[]; offset: readonly [number, number] }>;
	/** 0.17 (#71): the snap guides to show while the selection is dragged (page coordinates of `pageIndex`). Absent: none. */
	guides?: readonly SnapGuide[];
}

/**
 * v9: an element being edited in a panel (a graph whose functions, parameters or view change live): `before` and
 * `hideStrokes` are hidden from the static layer, `after` and `showStrokes` (the ink on it, moved) are drawn on the live
 * layer, until the edit is committed or cancelled.
 */
export interface ElementDraft {
	pageIndex: number;
	before: PageElement;
	after: PageElement;
	hideStrokes: readonly Stroke[];
	showStrokes: readonly Stroke[];
}

export interface RendererOptions {
	/**
	 * Ask for a low-latency (`desynchronized`) context for the pen's wet canvas. Off by default: on
	 * some Android GPUs such a canvas is composited as an opaque overlay. When the browser does not
	 * grant it, the wet canvas is a regular one.
	 */
	lowLatency?: boolean;
}

/**
 * 2D context for a wet-ink canvas: `desynchronized` only when asked, and a regular context when the
 * low-latency one cannot be created. `desynchronized` reports what the browser actually granted.
 */
export function createWetContext(canvas: HTMLCanvasElement, lowLatency: boolean): { ctx: CanvasRenderingContext2D | null; desynchronized: boolean } {
	if (lowLatency) {
		try {
			const ctx = canvas.getContext("2d", { desynchronized: true });
			if (ctx) return { ctx, desynchronized: ctx.getContextAttributes?.().desynchronized === true };
		} catch {
			// Fall through to a regular context (on a new canvas: a canvas keeps its first context).
		}
		return { ctx: null, desynchronized: false };
	}
	return { ctx: canvas.getContext("2d"), desynchronized: false };
}

export interface RenderStats {
	/** Duration of the last full static redraw, ms. */
	staticMs: number;
	/** Strokes drawn in the last full static redraw (after page and bounds culling). */
	strokesDrawn: number;
	pagesDrawn: number;
	/** Level of detail of the last full static redraw: 0 = exact strokes, 1..4 = simplified (see ink/lod.ts). */
	lodLevel: number;
}

/**
 * Two stacked canvases sized to the view × devicePixelRatio:
 * - static: paper, grid and saved strokes of the visible pages only; redrawn when the document or
 *   the view changes;
 * - live: the stroke in progress, the lasso and the floating selection, redrawn every frame they change.
 *
 * While panning or zooming a heavy page, the static layer is moved with a CSS transform and fully
 * redrawn once the gesture settles, so navigation stays smooth.
 */
export class Renderer {
	readonly staticCanvas: HTMLCanvasElement;
	readonly liveCanvas: HTMLCanvasElement;
	/** Wet ink of the pen, above the others (low-latency `desynchronized` only when enabled and granted). */
	wetCanvas: HTMLCanvasElement;
	/** The pen's wet canvas has a desynchronized context. */
	desynchronized = false;
	readonly stats: RenderStats = { staticMs: 0, strokesDrawn: 0, pagesDrawn: 0, lodLevel: 0 };
	/** Called after each animation frame that drew something (for the performance overlay). */
	onFrame: ((frameStart: number) => void) | null = null;

	private readonly staticCtx: CanvasRenderingContext2D;
	private readonly liveCtx: CanvasRenderingContext2D;

	private width = 0;
	private height = 0;
	private dpr = 1;
	private viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
	/** Viewport the static bitmap was drawn with (for the CSS fast path). */
	private drawnViewport: Viewport = this.viewport;
	private pages: readonly Page[] = [];
	/** v9: numbers of the numbered equations, recomputed when the numbered equations change. */
	private numbers: ReadonlyMap<string, number> = new Map();
	private numbersKey = "";
	private layout: Layout | null = null;
	private live: LiveStroke | null = null;
	/** v23 (#99): the rectangle of the area highlighter being dragged, on the live layer (never saved). */
	private areaPreview: { pageIndex: number; area: AreaElement } | null = null;
	private lasso: LassoOverlay | null = null;
	private selection: SelectionOverlay | null = null;
	private peek: PeekOverlay | null = null;
	private ghost: GhostOverlay | null = null;
	private ghostTimer: number | null = null;
	private draft: ElementDraft | null = null;
	/** Content shown shifted while the insert/remove-space tool is dragged (hidden from the static layer meanwhile). */
	private spacePreview: readonly SpacePreviewEntry[] | null = null;
	private hidden: ReadonlySet<Stroke> | null = null;
	private hiddenElements: ReadonlySet<PageElement> | null = null;
	/** Reading options of the view (never saved): ink and elements of PDF pages are not drawn; backgrounds are drawn with this opacity. */
	private hideAnnotations = false;
	private backgroundAlpha = 1;
	/** 0.22 (#101): view-only "filter by meaning": ink for which this says true is drawn faint (never saved; the static layer is redrawn once when it changes). */
	private inkDim: ((stroke: Pick<Stroke, "color">) => boolean) | null = null;
	private dimNow = false;
	private figureLabels: FigureLabelSource | null = null;
	/** wave 0.9 (367): night mode, view-only. Colours are mapped when they are drawn; the document is never touched. */
	private night = false;
	private readonly nightInkColor = memoColors(nightInk);
	private readonly nightHighlighterColor = memoColors(nightHighlighter);
	private readonly nightLineColor = memoColors(nightLine);
	private selectedElements: ReadonlySet<PageElement> | null = null;
	private ruler: RulerOverlay | null = null;
	private media: MediaSource | null = null;
	/** v8 invisible ink: whether the hidden strokes of a page are shown ("Show solutions", view-only). Null: never. */
	private revealHidden: ((page: Page) => boolean) | null = null;
	/** 0.15 (#75): paints the automatic page header or footer, in page coordinates, right after the paper (null: none). */
	private pageDecor: ((ctx: CanvasRenderingContext2D, page: Page, index: number, night: boolean) => void) | null = null;
	/** v8: the label of a structured box (translated by the view). */
	private boxLabel: BoxLabel | undefined = undefined;

	private staticDirty = true;
	private liveDirty = false;
	private frame: number | null = null;
	private settleTimer: number | null = null;

	private readonly container: HTMLElement;
	private wetPen: WetInk;
	private lowLatency: boolean;
	/** Painting wet ink failed: strokes in progress are shown on the live layer instead (see the view). */
	private wetFailed = false;
	private readonly errors = new ErrorOnce("render");
	/** Contexts whose state (save stack, clip) may be off after an error: reset before their next full redraw. */
	private readonly faulted = new Set<CanvasRenderingContext2D>();
	/** Wet ink of the highlighter (created on first use): a regular canvas, see releaseWet(). */
	private wetHl: WetInk | null = null;
	/**
	 * Wet ink of the marker (format v20): 85% opaque like the committed stroke, see markerWet(). Review fix (D4): created when a marker
	 * stroke starts and released a few seconds after the last one, so no full-viewport bitmap stays for the life of the view.
	 */
	private readonly wetMkLazy = new LazyWet<WetInk>({
		create: () => this.createMarkerWet(),
		dispose: (w) => {
			w.canvas.remove();
			w.canvas.width = 0;
			w.canvas.height = 0;
		},
		busy: (w) => this.wet === w || this.wetRelease.some((r) => r.wet === w),
	});
	private get wetMk(): WetInk | null {
		return this.wetMkLazy.peek();
	}
	/** The canvas showing the stroke in progress. */
	private wet: WetInk | null = null;
	private wetPage = -1;
	/** The finished wet stroke, about to be added to the static layer. */
	private wetDone: Stroke | null = null;
	/** Wet canvases to clear once the static layer shows their stroke, with the frames to wait. */
	private readonly wetRelease: Array<{ wet: WetInk; frames: number; tapered: boolean }> = [];

	private readonly paths = new WeakMap<Stroke, Path2D>();
	/** v22 (#37): the polygon of the fill of a closed shape, by stroke. */
	private readonly fillPaths = new WeakMap<Stroke, Path2D>();
	/** Paths of strokes drawn from simplified points, per LOD level (drawing cache only, see ink/lod.ts). */
	private readonly lodPaths = new WeakMap<Stroke, Array<Path2D | null | undefined>>();
	/** Level of detail for committed strokes: set by each full static redraw from the zoom. */
	private lod = 0;
	private lodEnabled = true;
	private readonly bounds = new WeakMap<Stroke, BBox>();

	constructor(container: HTMLElement, options: RendererOptions = {}) {
		// CSS sizes the canvases to the container; only the backing store size is set here.
		this.staticCanvas = container.createEl("canvas", { cls: "notebook-canvas notebook-canvas-static" });
		this.liveCanvas = container.createEl("canvas", { cls: "notebook-canvas notebook-canvas-live" });
		this.container = container;
		const s = this.staticCanvas.getContext("2d");
		const l = this.liveCanvas.getContext("2d");
		if (!s || !l) throw new Error("Canvas 2D is not available");
		this.staticCtx = s;
		this.liveCtx = l;
		this.lowLatency = options.lowLatency === true;
		const wet = this.createPenWet(this.lowLatency);
		this.wetCanvas = wet.canvas;
		this.wetPen = wet;
	}

	/**
	 * The pen's wet canvas. `desynchronized` is a low-latency hint (Chromium: the canvas may be shown
	 * without waiting for the compositor); if the low-latency context cannot be created, a regular
	 * canvas is used.
	 */
	private createPenWet(lowLatency: boolean): WetInk {
		const make = () => this.container.createEl("canvas", { cls: "notebook-canvas notebook-canvas-live notebook-canvas-wet" });
		let canvas = make();
		let { ctx, desynchronized } = createWetContext(canvas, lowLatency);
		if (!ctx) {
			canvas.remove();
			canvas = make();
			({ ctx, desynchronized } = createWetContext(canvas, false));
		}
		if (!ctx) throw new Error("Canvas 2D is not available");
		this.desynchronized = desynchronized;
		return new WetInk(canvas, ctx);
	}


	/** Turns the low-latency wet canvas on or off (the canvas is replaced; a stroke in progress is dropped from it). */
	setLowLatency(on: boolean): void {
		if (on === this.lowLatency) return;
		this.lowLatency = on;
		if (this.wet === this.wetPen) this.cancelWet();
		for (let i = this.wetRelease.length - 1; i >= 0; i--) if (this.wetRelease[i]!.wet === this.wetPen) this.wetRelease.splice(i, 1);
		const old = this.wetCanvas;
		const wet = this.createPenWet(on);
		// Same place in the stack: right where the old one was (under the highlighter's wet canvas).
		old.replaceWith(wet.canvas);
		wet.canvas.width = old.width;
		wet.canvas.height = old.height;
		this.wetCanvas = wet.canvas;
		this.wetPen = wet;
	}

	boundsOf = (stroke: Stroke): BBox => {
		let b = this.bounds.get(stroke);
		if (!b) {
			b = strokeBounds(stroke);
			this.bounds.set(stroke, b);
		}
		return b;
	};

	resize(width: number, height: number, dpr: number): void {
		if (width === this.width && height === this.height && dpr === this.dpr) return;
		this.width = width;
		this.height = height;
		this.dpr = dpr;
		for (const c of [this.staticCanvas, this.liveCanvas, this.wetCanvas, this.wetHl?.canvas, this.wetMk?.canvas]) {
			if (!c) continue;
			c.width = Math.max(1, Math.round(width * dpr));
			c.height = Math.max(1, Math.round(height * dpr));
		}
		// Resizing cleared the wet canvases: a stroke in progress is painted again.
		this.wetRelease.length = 0;
		this.retransformWet(true);
		this.invalidate();
	}

	/**
	 * `interactive`: part of a pan/zoom gesture. If full redraws are slow, the old bitmap is moved
	 * with CSS and redrawn when the gesture pauses.
	 */
	setViewport(v: Viewport, interactive = false): void {
		this.viewport = v;
		this.liveDirty = true;
		this.retransformWet();
		if (interactive && this.stats.staticMs > 12 && !this.staticDirty) {
			this.applyCssTransform();
			if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
			this.settleTimer = window.setTimeout(() => {
				this.settleTimer = null;
				this.invalidate();
			}, 120);
			this.schedule();
			return;
		}
		this.invalidate();
	}

	/**
	 * wave 0.9 (367): dark paper, light ink, lively highlighter (ink/night.ts). View-only: stored colours, exports and
	 * thumbnails are not affected. The container gets the class `notebook-night` (the wet highlighter canvas blends with CSS).
	 */
	setNight(on: boolean): void {
		if (on === this.night) return;
		this.night = on;
		this.container.toggleClass("notebook-night", on);
		this.invalidate();
	}

	get nightMode(): boolean {
		return this.night;
	}

	/** The colour `color` is drawn with: itself, or its night-mode counterpart. */
	private inkColor(tool: Tool, color: string): string {
		if (!this.night) return color;
		return tool === "highlighter" ? this.nightHighlighterColor(color) : this.nightInkColor(color);
	}

	/** Bitmaps for PDF/scan backgrounds and image elements. */
	setMedia(media: MediaSource | null): void {
		this.media = media;
		this.invalidate();
	}

	/** 0.15 (#75): a painter called once per visible page in the static layer, after the paper; the view owns what it draws. */
	setPageDecor(decor: ((ctx: CanvasRenderingContext2D, page: Page, index: number, night: boolean) => void) | null): void {
		this.pageDecor = decor;
		this.invalidate();
	}

	/** v8 invisible ink: hidden strokes are drawn only on the pages for which `reveal` is true (null: on none). */
	setHiddenInk(reveal: ((page: Page) => boolean) | null): void {
		this.revealHidden = reveal;
		this.invalidate();
	}

	/** v8: how structured boxes are labelled (the view passes translated kind names). */
	setBoxLabel(label: BoxLabel | undefined): void {
		this.boxLabel = label;
		this.invalidate();
	}

	/** Elements being edited or transformed are drawn elsewhere (live layer or DOM editor). */
	setHiddenElements(elements: ReadonlySet<PageElement> | null): void {
		this.hiddenElements = elements;
		this.invalidate();
	}

	/** View-only reading options: hide the ink and elements of PDF pages (to reread the clean PDF) and/or draw backgrounds lighter (`backgroundAlpha` < 1). */
	setReading(hideAnnotations: boolean, backgroundAlpha: number): void {
		if (hideAnnotations === this.hideAnnotations && backgroundAlpha === this.backgroundAlpha) return;
		this.hideAnnotations = hideAnnotations;
		this.backgroundAlpha = backgroundAlpha;
		this.invalidate();
	}

	/** 0.29 (#248) review fix (F1): the source of the figure numbers of the notebook this renderer draws (null: the ambient fallback). */
	setFigureLabels(source: FigureLabelSource | null): void {
		if (source === this.figureLabels) return;
		this.figureLabels = source;
		this.invalidate();
	}

	/** View-only: draws the strokes for which `dim` is true faint (null: no filter). */
	setInkDim(dim: ((stroke: Pick<Stroke, "color">) => boolean) | null): void {
		if (dim === this.inkDim) return;
		this.inkDim = dim;
		this.invalidate();
	}

	setDocument(pages: readonly Page[] | null, layout: Layout | null): void {
		this.pages = pages ?? [];
		this.numbersKey = "";
		this.layout = layout;
		this.retransformWet();
		this.invalidate();
	}

	/** Turns the level of detail for zoomed-out strokes on or off (on by default; off only to compare in benchmarks). */
	setLodEnabled(enabled: boolean): void {
		if (this.lodEnabled === enabled) return;
		this.lodEnabled = enabled;
		this.invalidate();
	}

	/** Full redraw of the static layer on the next frame. */
	invalidate(): void {
		this.staticDirty = true;
		this.liveDirty = true;
		this.schedule();
	}

	/**
	 * Adds a just-committed stroke to the static layer without redrawing everything. For the stroke
	 * just written as wet ink this draws the same geometry the wet canvas shows (the committed
	 * path of the same nodes), then the wet canvas is cleared: nothing visibly changes. (Copying the
	 * wet pixels instead was measured slower: reading a low-latency canvas back costs milliseconds.)
	 */
	appendStroke(pageIndex: number, stroke: Stroke): void {
		const box = this.layout?.boxes[pageIndex];
		const wet = this.wet;
		const fromWet = wet !== null && stroke === this.wetDone;
		if (fromWet) {
			this.wet = null;
			this.wetDone = null;
		}
		if (this.staticDirty || !box || this.staticCanvas.style.transform) {
			this.invalidate();
			if (wet && fromWet) this.releaseWet(wet, false, strokeTaper(stroke) !== undefined);
			return;
		}
		const ctx = this.staticCtx;
		this.beginPage(ctx, box);
		let drawn = true;
		try {
			this.fillStroke(ctx, stroke, this.lod);
		} catch (e) {
			this.fault(ctx, "stroke", e);
			drawn = false;
		} finally {
			ctx.restore();
		}
		if (!drawn) this.invalidate();
		if (wet && fromWet) this.releaseWet(wet, drawn, strokeTaper(stroke) !== undefined);
	}

	// --- wet ink (the stroke being written) ---

	/** Starts painting a stroke as it is written; `g` is filled by the caller and painted with paintWet(). */
	/**
	 * Returns false when the stroke cannot be shown as wet ink (no page, or wet ink failed earlier):
	 * the caller then shows it on the live layer (setLive).
	 */
	beginWet(pageIndex: number, g: InkBuilder, tool: Tool, color: string, opacity?: number): boolean {
		if (this.wetFailed) return false;
		const t = this.pageTransform(pageIndex);
		if (!t) return false;
		this.cancelWet();
		try {
			const wet = tool === "highlighter" ? this.highlighterWet() : tool === "marker" ? this.markerWet() : this.wetPen;
			// A previous stroke still waiting to be cleared from this canvas: make sure the static layer
			// shows it (a full redraw may still be pending) before it leaves the wet canvas.
			for (let i = this.wetRelease.length - 1; i >= 0; i--) {
				if (this.wetRelease[i]!.wet !== wet) continue;
				if (this.staticDirty) this.drawStatic();
				wet.clear();
				this.wetRelease.splice(i, 1);
			}
			wet.begin(g, tool, this.inkColor(tool, color), t);
			this.setWetOpacity(wet, tool, opacity);
			this.wet = wet;
			this.wetPage = pageIndex;
			return true;
		} catch (e) {
			this.failWet(e);
			return false;
		}
	}

	/**
	 * Format v24 (#358): the stroke about to be written shows through its wet canvas with its opacity. The pen's wet canvas holds opaque ink and has
	 * no translucency of its own; the highlighter's and the marker's get theirs from CSS (35 % multiplied, 85 %), so a stroke with an opacity
	 * overrides it with the product, keeping the blend mode (overlaps within one stroke still never darken twice). Without an opacity the inline
	 * value is removed and the stylesheet decides, exactly as before.
	 */
	private setWetOpacity(wet: WetInk, tool: Tool, opacity: number | undefined): void {
		const canvas = wet.canvas;
		if (opacity === undefined || opacityOf({ opacity }) >= 1) {
			canvas.style.removeProperty("opacity");
			return;
		}
		const base = tool === "highlighter" ? (this.night ? NIGHT_HIGHLIGHTER_ALPHA : HIGHLIGHTER_ALPHA) : tool === "marker" ? MARKER_ALPHA : 1;
		canvas.setCssProps({ opacity: String(Math.round(base * opacityOf({ opacity }) * 1000) / 1000) });
	}

	/** The wet stroke in progress (to set its tip points), or null. */
	get wetInk(): WetInk | null {
		return this.wet;
	}

	/**
	 * Paints the new part of the wet stroke now (call from the input handler). Returns false if
	 * there is no wet stroke or painting it failed (wet ink is then off for this view).
	 */
	paintWet(): boolean {
		const wet = this.wet;
		if (!wet) return false;
		try {
			wet.paint();
			return true;
		} catch (e) {
			this.failWet(e);
			return false;
		}
	}

	/**
	 * The wet stroke is finished (its geometry too) and `stroke`, its frozen copy, is about to be
	 * committed with appendStroke(); null discards it.
	 */
	endWet(stroke: Stroke | null): void {
		const wet = this.wet;
		if (!wet) return;
		if (stroke) {
			try {
				wet.clearExtra();
				wet.paint();
				this.wetDone = stroke;
			} catch (e) {
				// The static layer draws the stroke on the next frame.
				this.failWet(e);
				this.invalidate();
			}
		} else {
			this.cancelWet();
		}
	}

	/** Discards the wet stroke at once (cancelled, or replaced by a recognised shape). */
	cancelWet(): void {
		const wet = this.wet;
		this.wet = null;
		this.wetDone = null;
		if (wet) this.errors.run("wet clear", () => wet.clear());
		if (wet && wet === this.wetMk) this.wetMkLazy.idle();
	}

	/** Wet ink threw: drop it, and show later strokes on the live layer (always works, one frame later). */
	private failWet(e: unknown): void {
		this.errors.report("wet ink", e);
		this.wetFailed = true;
		this.cancelWet();
		this.wetRelease.length = 0;
		for (const w of [this.wetPen, this.wetHl, this.wetMk]) {
			if (!w) continue;
			this.errors.run("wet clear", () => {
				w.ctx.setTransform(1, 0, 0, 1, 0, 0);
				w.ctx.clearRect(0, 0, w.canvas.width, w.canvas.height);
			});
		}
	}

	/**
	 * Clears a finished wet canvas once the static layer shows its stroke. The highlighter canvas is
	 * a regular canvas, updated in the same frame as the static one: cleared at once when the stroke
	 * was drawn on the static layer, else right after the next static redraw. The pen canvas may be presented ahead
	 * of the compositor, so it is cleared two frames later; meanwhile the same opaque ink is shown
	 * twice at the same place.
	 */
	private releaseWet(wet: WetInk, staticHasIt: boolean, tapered = false): void {
		if (wet === this.wetMk) this.wetMkLazy.idle();
		const sync = wet !== this.wetPen;
		if (sync && staticHasIt) {
			wet.clear();
			return;
		}
		// Format v24 (#358): a translucent pen stroke shown twice for the two frames of the delay would darken for a moment (the opaque ink did not
		// show): its canvas is hidden as soon as the static layer has the stroke (both change in the same frame), and cleared later as before.
		// Format v25 (#351): the same for a tapered stroke, whose end was thinned at the lift: the wet canvas still holds the tail as it was painted
		// (full width, with a notch where the provisional tip was redrawn), which the static layer's pointed end must replace in the same frame.
		if (staticHasIt) this.hideWet(wet, tapered);
		this.wetRelease.push({ wet, frames: sync ? 0 : 1, tapered });
		this.schedule();
	}

	/**
	 * Hides a wet canvas that holds a stroke with an opacity (its inline opacity is set) or a tapered stroke (`tapered`); the canvas of an opaque,
	 * untapered pen stroke is left to the delayed clear (the same ink shows twice at the same place for a moment). The next stroke on this canvas
	 * shows it again (`setWetOpacity` runs at its start).
	 */
	private hideWet(wet: WetInk, tapered: boolean): void {
		if (wetHiddenAtLift(wet.canvas.style.getPropertyValue("opacity") !== "", tapered)) wet.canvas.setCssProps({ opacity: "0" });
	}

	private highlighterWet(): WetInk {
		if (this.wetHl) return this.wetHl;
		const canvas = this.container.createEl("canvas", { cls: "notebook-canvas notebook-canvas-live notebook-canvas-wet is-highlighter" });
		// Right above the pen's wet canvas, under anything the view adds later.
		this.wetCanvas.after(canvas);
		canvas.width = this.wetCanvas.width;
		canvas.height = this.wetCanvas.height;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas 2D is not available");
		this.wetHl = new WetInk(canvas, ctx);
		return this.wetHl;
	}

	/** Like highlighterWet(): the marker's wet canvas holds opaque ink and gets its 85% from CSS (`.is-marker`), so overlaps never darken twice. */
	private markerWet(): WetInk {
		return this.wetMkLazy.acquire();
	}

	private createMarkerWet(): WetInk {
		const canvas = this.container.createEl("canvas", { cls: "notebook-canvas notebook-canvas-live notebook-canvas-wet is-marker" });
		this.wetCanvas.after(canvas);
		canvas.width = this.wetCanvas.width;
		canvas.height = this.wetCanvas.height;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			canvas.remove();
			throw new Error("Canvas 2D is not available");
		}
		return new WetInk(canvas, ctx);
	}

	/** Page to device pixel transform of a page in the current view. */
	private pageTransform(pageIndex: number): PageTransform | null {
		const box = this.layout?.boxes[pageIndex];
		if (!box) return null;
		const { scale, offsetX, offsetY } = this.viewport;
		const d = this.dpr;
		return { k: d * scale, tx: d * (offsetX + box.x * scale), ty: d * (offsetY + box.y * scale), pageW: box.width, pageH: box.height };
	}

	private sameTransform(a: Readonly<PageTransform>, b: PageTransform | null): boolean {
		return !!b && a.k === b.k && a.tx === b.tx && a.ty === b.ty && a.pageW === b.pageW && a.pageH === b.pageH;
	}

	/** The view changed while a stroke is being written: repaint it for the new view. */
	private retransformWet(force = false): void {
		const wet = this.wet;
		if (!wet) return;
		const t = this.pageTransform(this.wetPage);
		if (t && (force || !this.sameTransform(wet.transform, t))) wet.setTransform(t);
	}

	/** v23 (#99): shows the area being dragged (null ends it). Only the live layer is redrawn. */
	setAreaPreview(preview: { pageIndex: number; area: AreaElement } | null): void {
		this.areaPreview = preview;
		this.liveDirty = true;
		this.schedule();
	}

	setLive(live: LiveStroke | null): void {
		this.live = live;
		this.liveDirty = true;
		this.schedule();
	}

	/** 0.20 (#94): shows (or, with null, removes) the ghost guide lines. They fade by themselves in "writing" mode. */
	setGhost(ghost: GhostOverlay | null): void {
		this.ghost = ghost;
		if (this.ghostTimer !== null) { window.clearTimeout(this.ghostTimer); this.ghostTimer = null; }
		this.liveDirty = true;
		this.schedule();
	}

	/** A new stroke began: the guides come back at full strength and the idle time starts again. */
	touchGhost(now: number): void {
		if (!this.ghost || this.ghost.since === now) return;
		// 0.20 review (D4): the guides only need a redraw when they had started to fade; otherwise nothing visible changes and
		// the first frame of the stroke stays free (the pending timer of "writing" mode re-arms itself from the new time).
		const fading = ghostTouchRedraws(this.ghost.mode, performance.now() - this.ghost.since);
		this.ghost = { ...this.ghost, since: now };
		if (!fading) return;
		this.liveDirty = true;
		this.schedule();
	}

	setLasso(lasso: LassoOverlay | null): void {
		this.lasso = lasso;
		this.liveDirty = true;
		this.schedule();
	}

	/** Shows a selection; its strokes are hidden from the static layer while it floats. */
	setSelection(selection: SelectionOverlay | null): void {
		this.selection = selection;
		const hidden = selection ? new Set(selection.strokes) : null;
		const hiddenEls = new Set<PageElement>(selection?.elements ?? []);
		for (const part of selection?.parts ?? []) {
			for (const s of part.strokes) hidden?.add(s);
			for (const e of part.elements) hiddenEls.add(e);
		}
		this.applyHidden(hidden, hiddenEls.size > 0 ? hiddenEls : null);
	}

	/**
	 * Shows the content below the line of the insert/remove-space tool shifted, on the live layer, and hides it
	 * from the static layer (the same mechanism as a floating selection; the two never exist together).
	 * Entries for a page that does not exist yet (`pageIndex` -1) are only hidden.
	 */
	setSpacePreview(entries: readonly SpacePreviewEntry[] | null): void {
		this.spacePreview = entries;
		if (!entries) {
			this.applyHidden(null, null);
			return;
		}
		const hidden = new Set<Stroke>();
		const hiddenEls = new Set<PageElement>();
		for (const e of entries) {
			for (const s of e.strokes) hidden.add(s);
			for (const el of e.elements) hiddenEls.add(el);
		}
		this.applyHidden(hidden, hiddenEls.size > 0 ? hiddenEls : null);
	}

	private applyHidden(hidden: ReadonlySet<Stroke> | null, hiddenEls: ReadonlySet<PageElement> | null): void {
		const changedHidden = (hidden?.size ?? 0) !== (this.hidden?.size ?? 0)
			|| (hidden !== null && [...hidden].some((s) => !this.hidden?.has(s)))
			|| (hiddenEls?.size ?? 0) !== (this.selectedElements?.size ?? 0)
			|| (hiddenEls !== null && [...hiddenEls].some((e) => !this.selectedElements?.has(e)));
		this.hidden = hidden;
		this.selectedElements = hiddenEls;
		if (changedHidden) this.staticDirty = true;
		this.liveDirty = true;
		this.schedule();
	}

	/** v9: shows an element being edited live (see ElementDraft); null ends it. Never together with a floating selection. */
	setElementDraft(draft: ElementDraft | null): void {
		this.draft = draft;
		this.applyHidden(draft ? new Set(draft.hideStrokes) : null, draft ? new Set([draft.before]) : null);
	}

	/** Strokes of another page drawn over this one while a button is held (wave 0.9: practice); view only, null removes them. */
	setPeek(peek: PeekOverlay | null): void {
		this.peek = peek;
		this.liveDirty = true;
		this.schedule();
	}

	/** Straight edge drawn over the page (null hides it). */
	setRuler(ruler: RulerOverlay | null): void {
		this.ruler = ruler;
		this.liveDirty = true;
		this.schedule();
	}

	/** Synchronous full redraw, for benchmarks. Returns the static layer's draw time in ms. */
	renderNow(): number {
		this.drawStatic();
		this.drawLive();
		return this.stats.staticMs;
	}

	/** Synchronous redraw of the live layer only, for benchmarks. Returns its draw time in ms. */
	renderLiveNow(): number {
		const t0 = performance.now();
		this.drawLive();
		return performance.now() - t0;
	}

	destroy(): void {
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
		this.cancelWet();
		this.wetRelease.length = 0;
		this.wetMkLazy.destroy();
		this.frame = null;
		this.settleTimer = null;
		if (this.ghostTimer !== null) window.clearTimeout(this.ghostTimer);
		this.ghostTimer = null;
	}

	private schedule(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame((t) => {
			this.frame = null;
			// Each step is guarded: an exception must never leave the page blank or stop later frames.
			if (this.staticDirty) this.errors.run("static layer", () => this.drawStatic());
			if (this.liveDirty) this.errors.run("live layer", () => this.drawLive());
			this.errors.run("wet release", () => this.releaseWetFrames());
			if (this.onFrame) this.errors.run("frame callback", () => this.onFrame?.(t));
		});
	}

	/** Asks for an animation frame even when nothing changed (performance overlay while writing). */
	requestFrame(): void {
		this.schedule();
	}

	private releaseWetFrames(): void {
		if (this.wetRelease.length === 0) return;
		for (let i = this.wetRelease.length - 1; i >= 0; i--) {
			const r = this.wetRelease[i]!;
			// The static layer has been redrawn by now: a translucent stroke must not show twice.
			if (!this.staticDirty && r.wet !== this.wet) this.hideWet(r.wet, r.tapered);
			if (r.frames-- > 0) continue;
			if (r.wet !== this.wet) r.wet.clear();
			this.wetRelease.splice(i, 1);
		}
		if (this.wetRelease.length > 0) this.schedule();
	}

	private applyCssTransform(): void {
		const a = this.drawnViewport;
		const b = this.viewport;
		const k = b.scale / a.scale;
		const tx = b.offsetX - a.offsetX * k;
		const ty = b.offsetY - a.offsetY * k;
		this.staticCanvas.setCssStyles({ transformOrigin: "0 0", transform: `matrix(${k}, 0, 0, ${k}, ${tx}, ${ty})` });
	}

	/** Saves the context and sets the transform to page-local coordinates, clipped to the page. */
	private beginPage(ctx: CanvasRenderingContext2D, box: PageBox, clip = true): void {
		const { scale, offsetX, offsetY } = this.viewport;
		const d = this.dpr;
		ctx.save();
		ctx.setTransform(d * scale, 0, 0, d * scale, d * (offsetX + box.x * scale), d * (offsetY + box.y * scale));
		if (clip) {
			ctx.beginPath();
			ctx.rect(0, 0, box.width, box.height);
			ctx.clip();
		}
	}

	private drawStatic(): void {
		const t0 = performance.now();
		// A finished wet stroke committed without appendStroke() (e.g. the page grew): this redraw shows it.
		const done = this.wetDone ? this.wet : null;
		if (done) {
			const tapered = this.wetDone !== null && strokeTaper(this.wetDone) !== undefined;
			this.wet = null;
			this.wetDone = null;
			this.releaseWet(done, true, tapered);
		}
		this.staticDirty = false;
		this.drawnViewport = this.viewport;
		this.lod = this.lodEnabled ? lodLevel(this.viewport.scale, this.dpr) : 0;
		this.staticCanvas.setCssStyles({ transform: "" });
		const ctx = this.staticCtx;
		this.resetIfFaulted(ctx);
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
		let strokesDrawn = 0;
		const layout = this.layout;
		const visibleDoc = this.visibleRect();
		const indices = layout ? visiblePages(layout, visibleDoc) : [];
		for (const i of indices) {
			const page = this.pages[i];
			const box = layout!.boxes[i]!;
			if (!page) continue;
			this.beginPage(ctx, box, false);
			try {
				ctx.shadowColor = SHADOW;
				ctx.shadowBlur = 8 * this.dpr;
				ctx.shadowOffsetY = 2 * this.dpr;
				ctx.fillStyle = this.night ? NIGHT_PAPER : PAPER;
				ctx.fillRect(0, 0, page.width, page.height);
			} finally {
				ctx.restore();
			}

			// Every part is guarded on its own: a bad background, element or stroke is skipped (and
			// logged once), the rest of the page is still drawn.
			this.beginPage(ctx, box);
			try {
				const visible: BBox = {
					minX: visibleDoc.minX - box.x, minY: visibleDoc.minY - box.y,
					maxX: visibleDoc.maxX - box.x, maxY: visibleDoc.maxY - box.y,
				};
				if (page.background) this.guarded(ctx, "background", () => this.drawBackground(ctx, page));
				this.guarded(ctx, "paper", () => this.drawPaper(ctx, page, visible));
				const decor = this.pageDecor;
				if (decor) this.guarded(ctx, "header", () => decor(ctx, page, i, this.night));
				const bare = this.hideAnnotations && page.background?.kind === "pdf";
				if (!bare && page.elements?.length) this.drawElements(ctx, page);
				const reveal = this.revealHidden?.(page) ?? false;
				const clips = graphClips(page.elements);
				// v15: the ink a collapsed sticky note keeps hidden is not drawn (it comes back when the note is opened).
				const noteInk = bare ? null : hiddenStickyInk(page.elements);
				for (const stroke of page.strokes) {
					if (bare || this.hidden?.has(stroke) || (stroke.hidden && !reveal) || noteInk?.has(stroke.id)) continue;
					try {
						const b = this.boundsOf(stroke);
						// Bounds are padded by half the width; pen ink reaches 0.8 × width at full pressure, and
						// the wet-ink curve may pass slightly outside its points.
						const m = stroke.width * 0.3 + 1;
						if (b.maxX + m < visible.minX || b.minX - m > visible.maxX || b.maxY + m < visible.minY || b.minY - m > visible.maxY) continue;
						this.dimNow = this.inkDim?.(stroke) ?? false;
						// v9: ink bound to a graph is clipped to its frame (a zoom may have carried it outside).
						const clip = strokeClip(stroke, clips);
						if (clip) {
							ctx.save();
							ctx.beginPath();
							ctx.rect(clip.x, clip.y, clip.width, clip.height);
							ctx.clip();
							this.fillStroke(ctx, stroke, this.lod);
							ctx.restore();
						} else this.fillStroke(ctx, stroke, this.lod);
						strokesDrawn++;
						if (this.dimNow) {
							this.dimNow = false;
							ctx.globalAlpha = 1;
						}
					} catch (e) {
						this.dimNow = false;
						this.fault(ctx, "stroke", e);
						this.setInk(ctx, "pen", PAPER);
					}
				}
				// v8 marker badges go above the ink, so they stay visible and tappable.
				if (!bare && page.elements?.length) this.drawMarkers(ctx, page);
			} finally {
				ctx.restore();
			}
		}
		this.stats.staticMs = performance.now() - t0;
		this.stats.strokesDrawn = strokesDrawn;
		this.stats.pagesDrawn = indices.length;
		this.stats.lodLevel = this.lod;
	}

	/**
	 * PDF page or scan under the paper pattern. The source returns the best bitmap it has right away
	 * (possibly blurry) and calls `invalidate` again when a sharper one is ready.
	 */
	private drawBackground(ctx: CanvasRenderingContext2D, page: Page): void {
		const img = this.media?.background(page, this.viewport.scale * this.dpr) ?? null;
		// v6: the background keeps its box when the page has margins.
		const r = backgroundRect(page);
		if (img) {
			ctx.globalAlpha = this.backgroundAlpha;
			ctx.drawImage(img, r.x, r.y, r.width, r.height);
			if (this.night) {
				// Night mode dims a PDF or picture instead of inverting it (inverted pages change what a figure means).
				ctx.globalAlpha = NIGHT_BACKGROUND_VEIL;
				ctx.fillStyle = NIGHT_PAPER;
				ctx.fillRect(r.x, r.y, r.width, r.height);
			}
			return;
		}
		ctx.fillStyle = PLACEHOLDER;
		ctx.fillRect(r.x, r.y, r.width, r.height);
		const label = this.media?.backgroundLabel(page);
		if (label) {
			ctx.fillStyle = PLACEHOLDER_TEXT;
			ctx.font = `${Math.max(8, r.width / 40)}px sans-serif`;
			ctx.fillText(label, r.x + r.width * 0.08, r.y + r.height * 0.1, r.width * 0.84);
		}
	}

	/** v9 + wave 0.9 night mode: how a graph's colours are drawn at night (ink colours for curves, line colours for the grid). */
	private nightPalette(): GraphPalette {
		return { paper: NIGHT_PAPER, ink: this.nightInkColor, line: this.nightLineColor };
	}

	/** v9: the automatic equation numbers of the document (cheap when nothing numbered changed). */
	equationNumbers(): ReadonlyMap<string, number> {
		let key = "";
		for (const p of this.pages) for (const e of p.elements ?? []) if (e.type === "equation" && e.numbered) key += `${e.id}:${e.x}:${e.y};`;
		if (key !== this.numbersKey) {
			this.numbersKey = key;
			this.numbers = key === "" ? new Map() : equationNumbers(this.pages);
		}
		return this.numbers;
	}

	/** The bitmap an element draws: an image's asset, an excerpt's live picture or snapshot (v10); null for the others. */
	private elementImage(el: PageElement): CanvasImageSource | null {
		if (el.type === "image") return this.media?.image(el.asset) ?? null;
		if (el.type === "excerpt") return excerptImage(this.media, el, this.viewport.scale * this.dpr);
		return null;
	}

	/** Images and v10 excerpts, v9 graphs, v8 structured boxes, v9 equations, then text boxes; all under the ink. */
	private drawElements(ctx: CanvasRenderingContext2D, page: Page): void {
		const elements = page.elements ?? [];
		const skip = (el: PageElement) => !!(this.hiddenElements?.has(el) || this.selectedElements?.has(el));
		for (const el of elements) {
			if ((el.type !== "image" && el.type !== "excerpt") || skip(el)) continue;
			this.guarded(ctx, el.type === "image" ? "image element" : "excerpt element", () => drawElement(ctx, el, this.elementImage(el)));
		}
		for (const el of elements) {
			if (el.type !== "graph" || skip(el)) continue;
			// wave 0.9 night mode: the graph's paper, lines, curves and labels are mapped like the page's.
			this.guarded(ctx, "graph element", () => drawGraph(ctx, el, this.night ? this.nightPalette() : undefined));
		}
		for (const el of elements) {
			if (el.type !== "box" || skip(el)) continue;
			this.guarded(ctx, "box element", () => drawBox(ctx, el, this.boxLabel));
		}
		// v15 sticky notes: above the boxes, under the equations, the text boxes and all the ink (their own ink included).
		for (const el of elements) {
			if (el.type !== "sticky" || skip(el)) continue;
			this.guarded(ctx, "sticky element", () => drawSticky(ctx, el, this.night));
		}
		// v23 area highlighter: above the sticky notes, under the equations, the text boxes and all the ink, with the look of the highlighter
		// (multiplied in the day, screened at night); dimmed like highlighter ink in the "filter by meaning" view.
		for (const el of elements) {
			if (el.type !== "area" || skip(el)) continue;
			this.guarded(ctx, "area element", () => drawArea(ctx, el, this.areaPaint(el, this.inkDim?.(el) ?? false)));
		}
		const numbers = this.equationNumbers();
		for (const el of elements) {
			if (el.type !== "equation" || skip(el)) continue;
			this.guarded(ctx, "equation element", () => drawEquation(ctx, this.night ? { ...el, color: this.nightInkColor(el.color) } : el, numbers.get(el.id)));
		}
		for (const el of elements) {
			if (el.type !== "text" || skip(el)) continue;
			// Review fix (F1): the figure numbers of THIS notebook only, never those of another open view.
			this.guarded(ctx, "text element", () => withFigureScope(this.figureLabels, () => drawTextElement(ctx, this.night ? { ...el, color: this.nightInkColor(el.color) } : el)));
		}
	}

	/** v8 marker badges, v10 excerpt badges and v17 checkboxes, above the ink. */
	private drawMarkers(ctx: CanvasRenderingContext2D, page: Page): void {
		for (const el of page.elements ?? []) {
			if (this.hiddenElements?.has(el) || this.selectedElements?.has(el)) continue;
			if (el.type === "marker") this.guarded(ctx, "marker element", () => drawMarker(ctx, el));
			else if (el.type === "checkbox") this.guarded(ctx, "checkbox element", () => drawCheckbox(ctx, el, this.night ? this.nightInkColor(el.color) : el.color));
			else if (el.type === "excerpt") this.guarded(ctx, "excerpt badge", () => drawExcerptBadge(ctx, el, this.media?.excerptMissing?.(el) ?? false));
		}
	}

	/** Runs one drawing step with the context state saved around it; an exception is logged once and skipped. */
	private guarded(ctx: CanvasRenderingContext2D, scope: string, fn: () => void): void {
		ctx.save();
		try {
			fn();
		} catch (e) {
			this.fault(ctx, scope, e);
		} finally {
			ctx.restore();
		}
	}

	private fault(ctx: CanvasRenderingContext2D, scope: string, e: unknown): void {
		this.errors.report(scope, e);
		this.faulted.add(ctx);
	}

	/** After an error the context's save stack may be unbalanced (a clip left behind): start from a clean state. */
	private resetIfFaulted(ctx: CanvasRenderingContext2D): void {
		if (!this.faulted.delete(ctx)) return;
		const c = ctx as CanvasRenderingContext2D & { reset?: () => void };
		if (typeof c.reset === "function") c.reset();
		else {
			// Setting the size (even to the same value) resets the context state.
			const { width } = ctx.canvas;
			ctx.canvas.width = width;
		}
	}

	/** Paper pattern (grid, ruled, dots, millimetre), drawn with hairlines about one device pixel wide at any zoom. */
	private drawPaper(ctx: CanvasRenderingContext2D, page: Page, visible: BBox): void {
		const { scale } = this.viewport;
		const { lines, dots } = paperPattern(page, visible, {
			includeMinor: minorVisible(page.paper.spacing, scale),
		});
		const hairline = Math.max(0.6, this.dpr) / (scale * this.dpr);
		ctx.lineWidth = hairline;
		for (const kind of ["minor", "major", "margin"] as const) {
			ctx.strokeStyle = this.night ? this.nightLineColor(PAPER_COLORS[kind]) : PAPER_COLORS[kind];
			ctx.beginPath();
			let any = false;
			for (const l of lines) {
				if (l.kind !== kind) continue;
				ctx.moveTo(l.x1, l.y1);
				ctx.lineTo(l.x2, l.y2);
				any = true;
			}
			if (any) ctx.stroke();
		}
		if (dots.length > 0) {
			// About one device pixel in radius at any zoom.
			const r = Math.max(1, this.dpr * 0.6) / (scale * this.dpr);
			ctx.fillStyle = this.night ? this.nightLineColor(PAPER_COLORS.dot) : PAPER_COLORS.dot;
			ctx.beginPath();
			for (const [x, y] of dots) {
				ctx.moveTo(x + r, y);
				ctx.arc(x, y, r, 0, Math.PI * 2);
			}
			ctx.fill();
		}
	}

	private drawLive(): void {
		this.liveDirty = false;
		const ctx = this.liveCtx;
		this.resetIfFaulted(ctx);
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
		const boxes = this.layout?.boxes;
		if (!boxes) return;

		// 0.20 (#94): ghost guide lines, under every other overlay.
		const ghost = this.ghost;
		if (ghost && boxes[ghost.pageIndex]) this.guarded(ctx, "ghost lines", () => this.drawGhost(ctx, boxes[ghost.pageIndex]!, ghost));

		// Each overlay is guarded on its own (see drawStatic).
		const sel = this.selection;
		if (sel && boxes[sel.pageIndex]) this.guarded(ctx, "selection", () => {
			const box = boxes[sel.pageIndex]!;
			// A selection across pages floats over the gaps between them, so nothing is clipped to its page.
			const clip = !sel.parts || sel.parts.length === 0;
			this.drawSelectedItems(ctx, box, sel.strokes, sel.elements, sel.matrix, clip);
			for (const part of sel.parts ?? []) {
				const partBox = boxes[part.pageIndex];
				if (partBox) this.drawSelectedItems(ctx, partBox, part.strokes, part.elements, partMatrix(sel.matrix, part.offset[0], part.offset[1]), false);
			}
			this.drawSelectionFrame(ctx, box, sel);
		});

		const preview = this.spacePreview;
		if (preview) this.guarded(ctx, "space preview", () => {
			const visibleDoc = this.visibleRect();
			for (const e of preview) {
				const box = boxes[e.pageIndex];
				if (!box) continue;
				if (e.elements.length > 0) {
					this.beginPage(ctx, box);
					const m = translate(0, e.dy);
					for (const el of e.elements) {
						const moved = transformElement(el, m, measureText);
						drawElement(ctx, moved, this.elementImage(moved), this.boxLabel, this.equationNumbers());
					}
					ctx.restore();
				}
				// Only the ink that can be seen once shifted.
				const minY = visibleDoc.minY - box.y - e.dy;
				const maxY = visibleDoc.maxY - box.y - e.dy;
				this.beginPage(ctx, box);
				ctx.translate(0, e.dy);
				const page = this.pages[e.pageIndex];
				const reveal = !!page && (this.revealHidden?.(page) ?? false);
				for (const stroke of e.strokes) {
					if (stroke.hidden && !reveal) continue;
					const b = this.boundsOf(stroke);
					if (b.maxY + stroke.width < minY || b.minY - stroke.width > maxY) continue;
					this.fillStroke(ctx, stroke);
				}
				ctx.restore();
			}
		});

		const peek = this.peek;
		if (peek && peek.strokes.length > 0 && boxes[peek.pageIndex]) this.guarded(ctx, "peek", () => {
			const visibleDoc = this.visibleRect();
			const box = boxes[peek.pageIndex]!;
			const minY = visibleDoc.minY - box.y;
			const maxY = visibleDoc.maxY - box.y;
			this.beginPage(ctx, box);
			ctx.globalAlpha = 0.85;
			for (const stroke of peek.strokes) {
				const b = this.boundsOf(stroke);
				if (b.maxY + stroke.width < minY || b.minY - stroke.width > maxY) continue;
				this.fillStroke(ctx, stroke);
			}
			ctx.restore();
		});

		const draft = this.draft;
		if (draft && boxes[draft.pageIndex]) this.guarded(ctx, "element draft", () => {
			this.beginPage(ctx, boxes[draft.pageIndex]!);
			drawElement(ctx, draft.after, null, this.boxLabel, this.equationNumbers());
			const a = draft.after;
			if (a.type === "graph") {
				ctx.beginPath();
				ctx.rect(a.x, a.y, a.width, a.height);
				ctx.clip();
			}
			for (const stroke of draft.showStrokes) this.fillStroke(ctx, stroke);
			ctx.restore();
		});

		const ruler = this.ruler;
		if (ruler && boxes[ruler.pageIndex]) this.guarded(ctx, "ruler", () => this.drawRuler(ctx, boxes[ruler.pageIndex]!, ruler.ruler));

		const lasso = this.lasso;
		if (lasso && lasso.points.length > 1 && boxes[lasso.pageIndex]) this.guarded(ctx, "lasso", () => {
			this.beginPage(ctx, boxes[lasso.pageIndex]!, false);
			ctx.beginPath();
			lasso.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
			ctx.strokeStyle = SELECTION;
			ctx.lineWidth = 1.5 / this.viewport.scale;
			ctx.setLineDash([6 / this.viewport.scale, 4 / this.viewport.scale]);
			ctx.stroke();
			ctx.restore();
		});

		const live = this.live;
		if (live && live.points.length > 0 && boxes[live.pageIndex]) this.guarded(ctx, "live stroke", () => {
			this.beginPage(ctx, boxes[live.pageIndex]!);
			const points = live.predicted.length ? [...live.points, ...live.predicted] : live.points;
			// The end of the line is known at the lift only: the stroke in progress has its start taper and a full-width end (as the wet ink).
			const taper = writingTaper(strokeTaper({ tool: live.tool, render: RENDER_INK, taperStart: live.taperStart, taperEnd: live.taperEnd }));
			// v22 (#37): the fill of the closed shape being dragged lies under its line (a dashed line is drawn as its runs).
			if (live.fill !== undefined && isFilled({ tool: live.tool, fill: live.fill, points })) this.fillShape(ctx, live.fill, live.fillTint === true, points, undefined, live.opacity);
			this.setInk(ctx, live.tool, live.color, live.opacity);
			if (live.dash !== undefined && live.tool === "shape") {
				ctx.fill(new Path2D(strokeSvgPath({ points, width: live.width, tool: live.tool, render: RENDER_FREEHAND, dash: live.dash })));
			} else if (isNewPen(live.tool) || taper) {
				// The new pens have no perfect-freehand outline: the same geometry as the wet ink, rebuilt from the points (so has a tapered line, v25).
				const path = new Path2D();
				inkPath(path, points, live.width, live.tool, live.nib, taper);
				ctx.fill(path);
			} else ctx.fill(new Path2D(strokePath(points, live.width, false, live.tool)));
			ctx.restore();
		});
		// v23 (#99): the rectangle of the area highlighter being dragged, with its final look and a hairline edge to read its corners.
		const area = this.areaPreview;
		if (area && boxes[area.pageIndex]) this.guarded(ctx, "area preview", () => {
			this.beginPage(ctx, boxes[area.pageIndex]!);
			drawArea(ctx, area.area, this.areaPaint(area.area, false));
			ctx.strokeStyle = this.inkColor("highlighter", area.area.color);
			ctx.globalAlpha = 0.9;
			ctx.lineWidth = 1 / this.viewport.scale;
			ctx.strokeRect(area.area.x, area.area.y, area.area.width, area.area.height);
			ctx.restore();
		});
	}

	/** How an area highlighter is painted: the highlighter's look in the day, its night counterpart at night, fainter when dimmed by the meaning filter. */
	private areaPaint(el: AreaElement, dim: boolean): { colour: string; alpha: number; blend: GlobalCompositeOperation } {
		return {
			colour: this.inkColor("highlighter", el.color),
			alpha: (this.night ? NIGHT_HIGHLIGHTER_ALPHA : HIGHLIGHTER_ALPHA) * (dim ? DIM_ALPHA : 1),
			blend: this.night ? "screen" : "multiply",
		};
	}

	/** Translucent straight edge with millimetre ticks and centimetre numbers; the working edge is the top one (before rotation). */
	private drawRuler(ctx: CanvasRenderingContext2D, box: PageBox, r: Ruler): void {
		const { scale } = this.viewport;
		const depth = 38;
		const [s, e] = rulerEdge(r);
		const nx = -Math.sin(r.angle);
		const ny = Math.cos(r.angle);
		this.beginPage(ctx, box, false);
		ctx.beginPath();
		ctx.moveTo(s[0], s[1]);
		ctx.lineTo(e[0], e[1]);
		ctx.lineTo(e[0] + nx * depth, e[1] + ny * depth);
		ctx.lineTo(s[0] + nx * depth, s[1] + ny * depth);
		ctx.closePath();
		ctx.fillStyle = "rgba(37, 99, 235, 0.14)";
		ctx.fill();
		ctx.strokeStyle = SELECTION;
		ctx.lineWidth = 1 / scale;
		ctx.stroke();
		// Ticks no closer than ~2 px on screen.
		const pxPerMm = scale * MM;
		const step = pxPerMm >= 2.2 ? 1 : pxPerMm * 5 >= 2.2 ? 5 : 10;
		ctx.lineWidth = 0.7 / scale;
		ctx.beginPath();
		const labels: Array<{ x: number; y: number; n: number }> = [];
		for (const tick of rulerTicks(r, step)) {
			ctx.moveTo(tick.x, tick.y);
			ctx.lineTo(tick.x + nx * tick.size, tick.y + ny * tick.size);
			if (tick.label !== undefined && tick.label > 0) labels.push({ x: tick.x + nx * (tick.size + 1), y: tick.y + ny * (tick.size + 1), n: tick.label });
		}
		ctx.stroke();
		ctx.fillStyle = SELECTION;
		ctx.font = "8px sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		for (const l of labels) {
			ctx.save();
			ctx.translate(l.x, l.y);
			ctx.rotate(r.angle);
			ctx.fillText(String(l.n), 0, 0);
			ctx.restore();
		}
		ctx.restore();
	}

	/** Selected elements (under the ink, as they will be once committed: a text box cannot rotate) and strokes, with `matrix` applied. */
	private drawSelectedItems(
		ctx: CanvasRenderingContext2D, box: PageBox, strokes: readonly Stroke[], elements: readonly PageElement[], matrix: Matrix, clip: boolean,
	): void {
		if (elements.length > 0) {
			this.beginPage(ctx, box, clip);
			for (const el of elements) {
				const moved = transformElement(el, matrix, measureText);
				drawElement(ctx, moved, this.elementImage(moved), this.boxLabel, this.equationNumbers());
			}
			ctx.restore();
		}
		this.beginPage(ctx, box, clip);
		const [a, b, c, d, e, f] = matrix;
		ctx.transform(a, b, c, d, e, f);
		for (const stroke of strokes) this.fillStroke(ctx, stroke);
		ctx.restore();
	}

	/** Dashed box with a scale handle (bottom-right) and a rotate handle (above the top edge), in screen space. */
	private drawSelectionFrame(ctx: CanvasRenderingContext2D, box: PageBox, sel: SelectionOverlay): void {
		if (sel.guides && sel.guides.length > 0) this.drawSnapGuides(ctx, box, sel.guides);
		const corners = selectionCorners(sel.bounds, sel.matrix).map(([x, y]) => this.pageToScreen(box, x, y));
		const d = this.dpr;
		ctx.save();
		ctx.setTransform(d, 0, 0, d, 0, 0);
		ctx.strokeStyle = SELECTION;
		ctx.lineWidth = 1.5;
		ctx.setLineDash([6, 4]);
		ctx.beginPath();
		corners.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
		ctx.closePath();
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.fillStyle = "#ffffff";
		const h = sel.handle;
		const handles = selectionHandles(sel.bounds, sel.matrix, h / this.viewport.scale);
		for (const [x, y] of [handles.scale, handles.rotate]) {
			const [sx, sy] = this.pageToScreen(box, x, y);
			ctx.beginPath();
			ctx.arc(sx, sy, h / 2, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
		}
		ctx.restore();
	}

	/**
	 * Faint dashed guides in screen space (one pixel wide at any zoom, `devicePixelRatio` aware). In "writing" mode they hold
	 * for `GHOST_IDLE_MS`, then fade; the next frame is asked for only while fading, never while idle or fully shown.
	 */
	private drawGhost(ctx: CanvasRenderingContext2D, box: PageBox, ghost: GhostOverlay): void {
		const elapsed = performance.now() - ghost.since;
		const fade = ghostAlpha(ghost.mode, elapsed);
		if (fade <= 0) {
			this.ghost = null;
			return;
		}
		if (ghost.mode === "writing") {
			if (elapsed < GHOST_IDLE_MS) {
				if (this.ghostTimer === null) {
					this.ghostTimer = window.setTimeout(() => {
						this.ghostTimer = null;
						this.liveDirty = true;
						this.schedule();
					}, GHOST_IDLE_MS - elapsed + 1);
				}
			} else {
				this.liveDirty = true;
				this.schedule();
			}
		}
		const d = this.dpr;
		ctx.save();
		ctx.setTransform(d, 0, 0, d, 0, 0);
		ctx.lineWidth = 1;
		ctx.lineCap = "round";
		ctx.setLineDash(GHOST_DASH);
		ctx.strokeStyle = this.night ? GHOST_COLOR_NIGHT : GHOST_COLOR;
		for (const s of ghost.segments) {
			const [x1, y1] = this.pageToScreen(box, s.x1, s.y1);
			const [x2, y2] = this.pageToScreen(box, s.x2, s.y2);
			ctx.globalAlpha = GHOST_ALPHA * fade * s.strength;
			ctx.beginPath();
			ctx.moveTo(x1, y1);
			ctx.lineTo(x2, y2);
			ctx.stroke();
		}
		ctx.restore();
	}

	/** Thin lines on the live layer while a drag is snapping (screen space, so they stay one pixel wide at any zoom). */
	private drawSnapGuides(ctx: CanvasRenderingContext2D, box: PageBox, guides: readonly SnapGuide[]): void {
		const d = this.dpr;
		ctx.save();
		ctx.setTransform(d, 0, 0, d, 0, 0);
		ctx.lineWidth = 1;
		ctx.setLineDash([]);
		for (const g of guides) {
			ctx.strokeStyle = g.kind === "grid" ? SNAP_GUIDE_GRID : g.kind === "page" || g.kind === "margin" ? SNAP_GUIDE_PAGE : SNAP_GUIDE_ITEM;
			const [x1, y1] = g.axis === "x" ? this.pageToScreen(box, g.pos, g.from) : this.pageToScreen(box, g.from, g.pos);
			const [x2, y2] = g.axis === "x" ? this.pageToScreen(box, g.pos, g.to) : this.pageToScreen(box, g.to, g.pos);
			// Half a pixel off, so a one pixel line is not smeared over two.
			ctx.beginPath();
			if (g.axis === "x") { const x = Math.round(x1) + 0.5; ctx.moveTo(x, y1); ctx.lineTo(x, y2); }
			else { const y = Math.round(y1) + 0.5; ctx.moveTo(x1, y); ctx.lineTo(x2, y); }
			ctx.stroke();
		}
		ctx.restore();
	}

	private pageToScreen(box: PageBox, x: number, y: number): [number, number] {
		const { scale, offsetX, offsetY } = this.viewport;
		return [(box.x + x) * scale + offsetX, (box.y + y) * scale + offsetY];
	}

	/** `opacity` (format v24, #358): the stroke's own, which multiplies the pen's alpha in every look (absent = 1). */
	private setInk(ctx: CanvasRenderingContext2D, tool: Tool, color: string, opacity?: number): void {
		ctx.fillStyle = this.inkColor(tool, color);
		const own = opacity === undefined ? 1 : opacityOf({ opacity });
		if (tool === "highlighter") {
			// Night mode: "multiply" would vanish on the dark paper, "screen" lights it.
			ctx.globalAlpha = (this.night ? NIGHT_HIGHLIGHTER_ALPHA : HIGHLIGHTER_ALPHA) * (this.dimNow ? DIM_ALPHA : 1) * own;
			ctx.globalCompositeOperation = this.night ? "screen" : "multiply";
		} else if (tool === "marker") {
			// Format v20: 85% opaque in stroke order, in the day and the night (the ink colour is already the night one).
			ctx.globalAlpha = MARKER_ALPHA * (this.dimNow ? DIM_ALPHA : 1) * own;
			ctx.globalCompositeOperation = "source-over";
		} else {
			ctx.globalAlpha = (this.dimNow ? DIM_ALPHA : 1) * own;
			ctx.globalCompositeOperation = "source-over";
		}
	}

	/** `lod` > 0: the path comes from simplified points (committed strokes of a zoomed-out view only; 0 = exact). */
	private fillStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, lod = 0): void {
		const path = (lod > 0 ? this.lodPath(stroke, lod) : null) ?? this.exactPath(stroke);
		// v22 (#37): the fill of a closed shape lies under its line.
		if (isFilled(stroke)) this.fillShape(ctx, stroke.fill!, stroke.fillTint === true, stroke.points, stroke, stroke.opacity);
		this.setInk(ctx, stroke.tool, stroke.color, stroke.opacity);
		ctx.fill(path);
		if (stroke.tool === "highlighter" || stroke.tool === "marker") this.setInk(ctx, "pen", stroke.color);
	}

	/**
	 * v22 (#37): paints the inside of a closed shape (the polygon through `points`) with `colour`, solid or as the translucent tint. The colour goes through
	 * the same night mapping as the ink, and the dimming of the colours-with-meaning view applies. `cached`: a committed stroke, whose polygon is remembered.
	 */
	private fillShape(ctx: CanvasRenderingContext2D, colour: string, tint: boolean, points: readonly Point[], cached?: Stroke, opacity?: number): void {
		let path = cached ? this.fillPaths.get(cached) : undefined;
		if (!path) {
			path = new Path2D(fillPathD(points));
			if (cached) this.fillPaths.set(cached, path);
		}
		ctx.fillStyle = this.inkColor("shape", colour);
		ctx.globalAlpha = fillAlpha({ fillTint: tint ? true : undefined, opacity }) * (this.dimNow ? DIM_ALPHA : 1);
		ctx.globalCompositeOperation = "source-over";
		ctx.fill(path);
	}

	private exactPath(stroke: Stroke): Path2D {
		let path = this.paths.get(stroke);
		if (!path) {
			path = this.buildPath(stroke, stroke.points);
			this.paths.set(stroke, path);
		}
		return path;
	}

	/** The stroke's path at a level of detail, or null when the exact path is to be used (remembered either way). */
	private lodPath(stroke: Stroke, lod: number): Path2D | null {
		let perLevel = this.lodPaths.get(stroke);
		if (!perLevel) this.lodPaths.set(stroke, (perLevel = []));
		let path = perLevel[lod];
		if (path === undefined) {
			path = this.buildLodPath(stroke, lod);
			perLevel[lod] = path;
		}
		return path;
	}

	private buildLodPath(stroke: Stroke, lod: number): Path2D | null {
		// v22: a dashed or dotted shape is drawn exactly (its runs are short; there is nothing to simplify).
		if (stroke.dash !== undefined) return null;
		if (stroke.render === RENDER_INK) {
			const nodes = lodNodes(stroke.points, stroke.width, stroke.tool, lod, stroke.nib, strokeTaper(stroke));
			if (!nodes) return null;
			const path = new Path2D();
			addLodNodesPath(path, nodes);
			return path;
		}
		const xy = lodPolygon(stroke.points, stroke.width, stroke.tool, lod);
		if (!xy) return null;
		const path = new Path2D();
		path.moveTo(xy[0]!, xy[1]!);
		for (let k = 2; k < xy.length; k += 2) path.lineTo(xy[k]!, xy[k + 1]!);
		path.closePath();
		return path;
	}

	private buildPath(stroke: Stroke, points: readonly Point[]): Path2D {
		// v22 (#37): a dashed or dotted shape is its runs, each an outline of its own.
		if (stroke.dash !== undefined && stroke.tool === "shape") return new Path2D(strokeSvgPath({ points, width: stroke.width, tool: stroke.tool, render: stroke.render, dash: stroke.dash }));
		if (stroke.render === RENDER_INK) {
			const path = new Path2D();
			inkPath(path, points, stroke.width, stroke.tool, stroke.nib, strokeTaper(stroke));
			return path;
		}
		return new Path2D(strokePath(points, stroke.width, true, stroke.tool));
	}

	/** Visible area in document coordinates. */
	private visibleRect(): BBox {
		const { scale, offsetX, offsetY } = this.viewport;
		return {
			minX: -offsetX / scale,
			minY: -offsetY / scale,
			maxX: (this.width - offsetX) / scale,
			maxY: (this.height - offsetY) / scale,
		};
	}
}

/** Corners of `bounds` after `matrix`, clockwise from top-left. */
export function selectionCorners(bounds: BBox, matrix: Matrix): Array<[number, number]> {
	const pts: Array<[number, number]> = [
		[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY], [bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY],
	];
	return pts.map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]);
}

/** Handle positions in page coordinates: scale at the bottom-right corner, rotate above the top edge. */
export function selectionHandles(bounds: BBox, matrix: Matrix, offset: number): { scale: [number, number]; rotate: [number, number] } {
	const [tl, tr, br] = selectionCorners(bounds, matrix) as [[number, number], [number, number], [number, number]];
	const midTop: [number, number] = [(tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2];
	// Outward normal of the top edge.
	const ex = tr[0] - tl[0], ey = tr[1] - tl[1];
	const len = Math.hypot(ex, ey) || 1;
	const nx = ey / len, ny = -ex / len;
	return { scale: br, rotate: [midTop[0] + nx * offset * 2.5, midTop[1] + ny * offset * 2.5] };
}
