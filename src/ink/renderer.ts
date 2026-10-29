import type { Page, PageElement, Point, Stroke, TextElement, Tool } from "../model/types";
import { layoutText } from "./text-layout";
import { strokeBounds, type BBox } from "./hit-test";
import { minorVisible, paperPattern, PAPER_COLORS } from "./paper";
import { visiblePages, type Layout, type PageBox } from "./layout";
import { HIGHLIGHTER_ALPHA, strokePath } from "./stroke-shape";
import type { Matrix } from "./transform";
import type { Viewport } from "./viewport";

const PAPER = "#ffffff";
const SHADOW = "rgba(0, 0, 0, 0.18)";
const SELECTION = "#2563eb";
const PLACEHOLDER = "#f1f5f9";
const PLACEHOLDER_TEXT = "#64748b";

/** Bitmaps the renderer cannot produce itself: PDF pages, scans, images. */
export interface MediaSource {
	/** Best available bitmap for the page background at `deviceScale` (device px per pt), or null while loading. */
	background(page: Page, deviceScale: number): CanvasImageSource | null;
	/** Text shown on the placeholder (e.g. "Loading…" or a missing file name). */
	backgroundLabel(page: Page): string | null;
	image(assetId: string): CanvasImageSource | null;
}

/** Draws a text box in page coordinates; used by the renderer, thumbnails and the live layer. */
export function drawTextElement(ctx: CanvasRenderingContext2D, el: TextElement): void {
	ctx.save();
	ctx.font = `${el.fontSize}px ${TEXT_FONT}`;
	ctx.fillStyle = el.color;
	ctx.textBaseline = "top";
	const layout = layoutText(el.text, el.fontSize, el.width, (str) => ctx.measureText(str).width);
	layout.lines.forEach((line, i) => ctx.fillText(line, el.x, el.y + i * layout.lineHeight + (layout.lineHeight - el.fontSize) / 2));
	ctx.restore();
}

/** Font used for text boxes on screen. */
export const TEXT_FONT = "sans-serif";

export interface LiveStroke {
	pageIndex: number;
	tool: Tool;
	color: string;
	width: number;
	points: readonly Point[];
	predicted: readonly Point[];
}

/** Lasso being drawn, in page coordinates. */
export interface LassoOverlay {
	pageIndex: number;
	points: ReadonlyArray<readonly [number, number]>;
}

/** Selected strokes, drawn on the live layer with a transform while they are moved, scaled or rotated. */
export interface SelectionOverlay {
	pageIndex: number;
	strokes: readonly Stroke[];
	matrix: Matrix;
	/** Selection bounds in page coordinates, before `matrix`. */
	bounds: BBox;
	/** Handle size in CSS px. */
	handle: number;
}

export interface RenderStats {
	/** Duration of the last full static redraw, ms. */
	staticMs: number;
	/** Strokes drawn in the last full static redraw (after page and bounds culling). */
	strokesDrawn: number;
	pagesDrawn: number;
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
	readonly stats: RenderStats = { staticMs: 0, strokesDrawn: 0, pagesDrawn: 0 };
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
	private layout: Layout | null = null;
	private live: LiveStroke | null = null;
	private lasso: LassoOverlay | null = null;
	private selection: SelectionOverlay | null = null;
	private hidden: ReadonlySet<Stroke> | null = null;
	private hiddenElements: ReadonlySet<PageElement> | null = null;
	private media: MediaSource | null = null;

	private staticDirty = true;
	private liveDirty = false;
	private frame: number | null = null;
	private settleTimer: number | null = null;

	private readonly paths = new WeakMap<Stroke, Path2D>();
	private readonly bounds = new WeakMap<Stroke, BBox>();

	constructor(container: HTMLElement) {
		// CSS sizes the canvases to the container; only the backing store size is set here.
		this.staticCanvas = container.createEl("canvas", { cls: "notebook-canvas notebook-canvas-static" });
		this.liveCanvas = container.createEl("canvas", { cls: "notebook-canvas notebook-canvas-live" });
		const s = this.staticCanvas.getContext("2d");
		// `desynchronized` is a low-latency hint (Chromium); other engines ignore it.
		const l = this.liveCanvas.getContext("2d", { desynchronized: true });
		if (!s || !l) throw new Error("Canvas 2D is not available");
		this.staticCtx = s;
		this.liveCtx = l;
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
		for (const c of [this.staticCanvas, this.liveCanvas]) {
			c.width = Math.max(1, Math.round(width * dpr));
			c.height = Math.max(1, Math.round(height * dpr));
		}
		this.invalidate();
	}

	/**
	 * `interactive`: part of a pan/zoom gesture. If full redraws are slow, the old bitmap is moved
	 * with CSS and redrawn when the gesture pauses.
	 */
	setViewport(v: Viewport, interactive = false): void {
		this.viewport = v;
		this.liveDirty = true;
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

	/** Bitmaps for PDF/scan backgrounds and image elements. */
	setMedia(media: MediaSource | null): void {
		this.media = media;
		this.invalidate();
	}

	/** Elements being edited or transformed are drawn elsewhere (live layer or DOM editor). */
	setHiddenElements(elements: ReadonlySet<PageElement> | null): void {
		this.hiddenElements = elements;
		this.invalidate();
	}

	setDocument(pages: readonly Page[] | null, layout: Layout | null): void {
		this.pages = pages ?? [];
		this.layout = layout;
		this.invalidate();
	}

	/** Full redraw of the static layer on the next frame. */
	invalidate(): void {
		this.staticDirty = true;
		this.liveDirty = true;
		this.schedule();
	}

	/** Adds a just-committed stroke to the static layer without redrawing everything. */
	appendStroke(pageIndex: number, stroke: Stroke): void {
		const box = this.layout?.boxes[pageIndex];
		if (this.staticDirty || !box || this.staticCanvas.style.transform) {
			this.invalidate();
			return;
		}
		const ctx = this.staticCtx;
		this.beginPage(ctx, box);
		this.fillStroke(ctx, stroke);
		ctx.restore();
	}

	setLive(live: LiveStroke | null): void {
		this.live = live;
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
		const hidden = selection ? new Set(selection.strokes) : null;
		const changedHidden = (hidden?.size ?? 0) !== (this.hidden?.size ?? 0)
			|| (hidden !== null && [...hidden].some((s) => !this.hidden?.has(s)));
		this.selection = selection;
		this.hidden = hidden;
		if (changedHidden) this.staticDirty = true;
		this.liveDirty = true;
		this.schedule();
	}

	/** Synchronous full redraw, for benchmarks. Returns the static layer's draw time in ms. */
	renderNow(): number {
		this.drawStatic();
		this.drawLive();
		return this.stats.staticMs;
	}

	destroy(): void {
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
		this.frame = null;
		this.settleTimer = null;
	}

	private schedule(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame((t) => {
			this.frame = null;
			if (this.staticDirty) this.drawStatic();
			if (this.liveDirty) this.drawLive();
			this.onFrame?.(t);
		});
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
		this.staticDirty = false;
		this.drawnViewport = this.viewport;
		this.staticCanvas.setCssStyles({ transform: "" });
		const ctx = this.staticCtx;
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
			ctx.shadowColor = SHADOW;
			ctx.shadowBlur = 8 * this.dpr;
			ctx.shadowOffsetY = 2 * this.dpr;
			ctx.fillStyle = PAPER;
			ctx.fillRect(0, 0, page.width, page.height);
			ctx.restore();

			this.beginPage(ctx, box);
			const visible: BBox = {
				minX: visibleDoc.minX - box.x, minY: visibleDoc.minY - box.y,
				maxX: visibleDoc.maxX - box.x, maxY: visibleDoc.maxY - box.y,
			};
			if (page.background) this.drawBackground(ctx, page);
			this.drawPaper(ctx, page, visible);
			if (page.elements?.length) this.drawElements(ctx, page);
			for (const stroke of page.strokes) {
				if (this.hidden?.has(stroke)) continue;
				const b = this.boundsOf(stroke);
				if (b.maxX < visible.minX || b.minX > visible.maxX || b.maxY < visible.minY || b.minY > visible.maxY) continue;
				this.fillStroke(ctx, stroke);
				strokesDrawn++;
			}
			ctx.restore();
		}
		this.stats.staticMs = performance.now() - t0;
		this.stats.strokesDrawn = strokesDrawn;
		this.stats.pagesDrawn = indices.length;
	}

	/**
	 * PDF page or scan under the paper pattern. The source returns the best bitmap it has right away
	 * (possibly blurry) and calls `invalidate` again when a sharper one is ready.
	 */
	private drawBackground(ctx: CanvasRenderingContext2D, page: Page): void {
		const img = this.media?.background(page, this.viewport.scale * this.dpr) ?? null;
		if (img) {
			ctx.drawImage(img, 0, 0, page.width, page.height);
			return;
		}
		ctx.fillStyle = PLACEHOLDER;
		ctx.fillRect(0, 0, page.width, page.height);
		const label = this.media?.backgroundLabel(page);
		if (label) {
			ctx.fillStyle = PLACEHOLDER_TEXT;
			ctx.font = `${Math.max(8, page.width / 40)}px sans-serif`;
			ctx.fillText(label, page.width * 0.08, page.height * 0.1, page.width * 0.84);
		}
	}

	/** Images, then text boxes; both under the ink. */
	private drawElements(ctx: CanvasRenderingContext2D, page: Page): void {
		const elements = page.elements ?? [];
		for (const el of elements) {
			if (el.type !== "image" || this.hiddenElements?.has(el)) continue;
			const img = this.media?.image(el.asset) ?? null;
			ctx.save();
			ctx.translate(el.x + el.width / 2, el.y + el.height / 2);
			if (el.rotation) ctx.rotate(el.rotation);
			if (img) ctx.drawImage(img, -el.width / 2, -el.height / 2, el.width, el.height);
			else {
				ctx.fillStyle = PLACEHOLDER;
				ctx.fillRect(-el.width / 2, -el.height / 2, el.width, el.height);
			}
			ctx.restore();
		}
		for (const el of elements) {
			if (el.type !== "text" || this.hiddenElements?.has(el)) continue;
			drawTextElement(ctx, el);
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
			ctx.strokeStyle = PAPER_COLORS[kind];
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
			ctx.fillStyle = PAPER_COLORS.dot;
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
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
		const boxes = this.layout?.boxes;
		if (!boxes) return;

		const sel = this.selection;
		if (sel && boxes[sel.pageIndex]) {
			const box = boxes[sel.pageIndex]!;
			this.beginPage(ctx, box);
			const [a, b, c, d, e, f] = sel.matrix;
			ctx.transform(a, b, c, d, e, f);
			for (const stroke of sel.strokes) this.fillStroke(ctx, stroke);
			ctx.restore();
			this.drawSelectionFrame(ctx, box, sel);
		}

		const lasso = this.lasso;
		if (lasso && lasso.points.length > 1 && boxes[lasso.pageIndex]) {
			this.beginPage(ctx, boxes[lasso.pageIndex]!, false);
			ctx.beginPath();
			lasso.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
			ctx.strokeStyle = SELECTION;
			ctx.lineWidth = 1.5 / this.viewport.scale;
			ctx.setLineDash([6 / this.viewport.scale, 4 / this.viewport.scale]);
			ctx.stroke();
			ctx.restore();
		}

		const live = this.live;
		if (live && live.points.length > 0 && boxes[live.pageIndex]) {
			this.beginPage(ctx, boxes[live.pageIndex]!);
			const points = live.predicted.length ? [...live.points, ...live.predicted] : live.points;
			this.setInk(ctx, live.tool, live.color);
			ctx.fill(new Path2D(strokePath(points, live.width, false, live.tool)));
			ctx.restore();
		}
	}

	/** Dashed box with a scale handle (bottom-right) and a rotate handle (above the top edge), in screen space. */
	private drawSelectionFrame(ctx: CanvasRenderingContext2D, box: PageBox, sel: SelectionOverlay): void {
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

	private pageToScreen(box: PageBox, x: number, y: number): [number, number] {
		const { scale, offsetX, offsetY } = this.viewport;
		return [(box.x + x) * scale + offsetX, (box.y + y) * scale + offsetY];
	}

	private setInk(ctx: CanvasRenderingContext2D, tool: Tool, color: string): void {
		ctx.fillStyle = color;
		if (tool === "highlighter") {
			ctx.globalAlpha = HIGHLIGHTER_ALPHA;
			ctx.globalCompositeOperation = "multiply";
		} else {
			ctx.globalAlpha = 1;
			ctx.globalCompositeOperation = "source-over";
		}
	}

	private fillStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
		let path = this.paths.get(stroke);
		if (!path) {
			path = new Path2D(strokePath(stroke.points, stroke.width, true, stroke.tool));
			this.paths.set(stroke, path);
		}
		this.setInk(ctx, stroke.tool, stroke.color);
		ctx.fill(path);
		if (stroke.tool === "highlighter") this.setInk(ctx, "pen", stroke.color);
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
