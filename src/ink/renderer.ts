import type { Page, Point, Stroke } from "../model/types";
import { strokeBounds, type BBox } from "./hit-test";
import { strokePath } from "./stroke-shape";
import type { Viewport } from "./viewport";

const PAPER = "#ffffff";
const GRID = "#cfdcea";
const SHADOW = "rgba(0, 0, 0, 0.18)";

export interface LiveStroke {
	color: string;
	width: number;
	points: readonly Point[];
	predicted: readonly Point[];
}

/**
 * Two stacked canvases sized to the view × devicePixelRatio:
 * - static: paper, grid and saved strokes; redrawn only when the document or the view changes;
 * - live: the stroke in progress, redrawn every animation frame while drawing.
 */
export class Renderer {
	readonly staticCanvas: HTMLCanvasElement;
	readonly liveCanvas: HTMLCanvasElement;
	private readonly staticCtx: CanvasRenderingContext2D;
	private readonly liveCtx: CanvasRenderingContext2D;

	private width = 0;
	private height = 0;
	private dpr = 1;
	private viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
	private page: Page | null = null;
	private live: LiveStroke | null = null;

	private staticDirty = true;
	private liveDirty = false;
	private frame: number | null = null;

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
		this.staticDirty = true;
		this.liveDirty = true;
		this.schedule();
	}

	setViewport(v: Viewport): void {
		this.viewport = v;
		this.invalidate();
	}

	setPage(page: Page | null): void {
		this.page = page;
		this.invalidate();
	}

	/** Full redraw of the static layer on the next frame. */
	invalidate(): void {
		this.staticDirty = true;
		this.liveDirty = true;
		this.schedule();
	}

	/** Adds a just-committed stroke to the static layer without redrawing everything. */
	appendStroke(stroke: Stroke): void {
		if (this.staticDirty) {
			this.schedule();
			return;
		}
		this.applyTransform(this.staticCtx);
		this.clipToPage(this.staticCtx);
		this.fillStroke(this.staticCtx, stroke);
		this.staticCtx.restore();
	}

	setLive(live: LiveStroke | null): void {
		this.live = live;
		this.liveDirty = true;
		this.schedule();
	}

	destroy(): void {
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.frame = null;
	}

	private schedule(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			if (this.staticDirty) this.drawStatic();
			if (this.liveDirty) this.drawLive();
		});
	}

	private applyTransform(ctx: CanvasRenderingContext2D): void {
		const { scale, offsetX, offsetY } = this.viewport;
		const d = this.dpr;
		ctx.save();
		ctx.setTransform(d * scale, 0, 0, d * scale, d * offsetX, d * offsetY);
	}

	private clipToPage(ctx: CanvasRenderingContext2D): void {
		if (!this.page) return;
		ctx.beginPath();
		ctx.rect(0, 0, this.page.width, this.page.height);
		ctx.clip();
	}

	private drawStatic(): void {
		this.staticDirty = false;
		const ctx = this.staticCtx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
		const page = this.page;
		if (!page) return;
		const { scale } = this.viewport;

		this.applyTransform(ctx);
		ctx.shadowColor = SHADOW;
		ctx.shadowBlur = 8 * this.dpr;
		ctx.shadowOffsetY = 2 * this.dpr;
		ctx.fillStyle = PAPER;
		ctx.fillRect(0, 0, page.width, page.height);
		ctx.shadowColor = "transparent";

		this.clipToPage(ctx);
		const visible = this.visibleRect();
		this.drawGrid(ctx, page, visible, scale);
		for (const stroke of page.strokes) {
			const b = this.boundsOf(stroke);
			if (b.maxX < visible.minX || b.minX > visible.maxX || b.maxY < visible.minY || b.minY > visible.maxY) continue;
			this.fillStroke(ctx, stroke);
		}
		ctx.restore();
	}

	private drawGrid(ctx: CanvasRenderingContext2D, page: Page, visible: BBox, scale: number): void {
		const step = page.paper.spacing;
		ctx.strokeStyle = GRID;
		// About one device pixel wide at any zoom.
		ctx.lineWidth = Math.max(0.6, this.dpr) / (scale * this.dpr);
		ctx.beginPath();
		const x0 = Math.max(step, Math.ceil(visible.minX / step) * step);
		for (let x = x0; x < Math.min(page.width, visible.maxX); x += step) {
			ctx.moveTo(x, 0);
			ctx.lineTo(x, page.height);
		}
		const y0 = Math.max(step, Math.ceil(visible.minY / step) * step);
		for (let y = y0; y < Math.min(page.height, visible.maxY); y += step) {
			ctx.moveTo(0, y);
			ctx.lineTo(page.width, y);
		}
		ctx.stroke();
	}

	private drawLive(): void {
		this.liveDirty = false;
		const ctx = this.liveCtx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
		const live = this.live;
		if (!live || live.points.length === 0) return;
		this.applyTransform(ctx);
		this.clipToPage(ctx);
		const points = live.predicted.length ? [...live.points, ...live.predicted] : live.points;
		ctx.fillStyle = live.color;
		ctx.fill(new Path2D(strokePath(points, live.width, false)));
		ctx.restore();
	}

	private fillStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
		let path = this.paths.get(stroke);
		if (!path) {
			path = new Path2D(strokePath(stroke.points, stroke.width, true));
			this.paths.set(stroke, path);
		}
		ctx.fillStyle = stroke.color;
		ctx.fill(path);
	}

	/** Visible area in page coordinates. */
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
