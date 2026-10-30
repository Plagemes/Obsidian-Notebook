// wave 0.9 (382): draws one page on a canvas at a given scale, for the PNG images of the Markdown export. Same look as the
// PDF and SVG exports: white sheet, background, paper, pictures, boxes, text, ink, markers; never the night-mode colours,
// never hidden ink unless the caller says so. The caller owns the canvas and the bitmaps (no 'obsidian' import).
import { backgroundRect } from "../model/margins";
import type { Page, PageElement, Stroke } from "../model/types";
import { PAPER_DOT_RADIUS, PAPER_LINE_WIDTH } from "./export-svg";
import { layerFlags, type ExportLayers } from "./export-layers";
import { defaultBoxLabel, drawBox, drawMarker, type BoxLabel } from "./marker-render";
import { PAPER_COLORS, paperPattern } from "./paper";
import { drawElement, drawTextElement } from "./renderer";
import { drawEquation, drawGraph } from "./math-render";
import { drawExcerpt } from "./excerpt-render";
import { graphClips, strokeClip } from "./attach";
import { equationNumbers } from "../model/math-elements";
import { HIGHLIGHTER_ALPHA, strokeSvgPath } from "./stroke-shape";

export interface RasterInputs {
	/** The PDF page or picture under the page, already drawn at a suitable size; null when there is none or it failed. */
	background: CanvasImageSource | null;
	/** Bitmaps of the picture elements by asset id; a missing one is left out. */
	images: ReadonlyMap<string, CanvasImageSource>;
	hiddenInk?: boolean;
	boxLabel?: BoxLabel;
	layers?: ExportLayers;
	/** v9: numbers of the numbered equations (default: counted on this page). */
	equationNumbers?: ReadonlyMap<string, number>;
	/**
	 * v10: draw only this part of the page (pt), its top-left corner at the canvas origin: the canvas is then
	 * `region.width × scale` by `region.height × scale` pixels (the picture of an anchored excerpt).
	 */
	region?: { x: number; y: number; width: number; height: number };
	/**
	 * v10: the elements whose graph frames clip bound ink (default: `page.elements`); a caller that passes a page with
	 * only some of its elements (the live picture of an excerpt) passes all of them here.
	 */
	clipElements?: readonly PageElement[];
	/** v10: shapes of strokes already built (strokes are immutable), filled as strokes are drawn. */
	paths?: WeakMap<Stroke, Path2D>;
}

/**
 * Paints `page` on `ctx` (a canvas of `page.width × scale` by `page.height × scale` pixels, or of the region's size).
 * v10 excerpts on the page draw their snapshot (`images` by asset id), never live: an excerpt of a page holding an
 * excerpt of it cannot recurse.
 */
export function drawPageRaster(ctx: CanvasRenderingContext2D, page: Page, scale: number, inputs: RasterInputs): void {
	const flags = layerFlags(inputs.layers);
	ctx.save();
	try {
		const region = inputs.region;
		ctx.setTransform(scale, 0, 0, scale, region ? -region.x * scale : 0, region ? -region.y * scale : 0);
		if (flags.background) {
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, page.width, page.height);
			if (inputs.background && page.background) {
				const r = backgroundRect(page);
				ctx.drawImage(inputs.background, r.x, r.y, r.width, r.height);
			}
			drawPaperLines(ctx, page);
		}
		if (!flags.content) return;
		const elements = page.elements ?? [];
		for (const el of elements) {
			if (el.type === "excerpt") {
				drawExcerpt(ctx, el, el.asset !== undefined ? inputs.images.get(el.asset) ?? null : null);
				continue;
			}
			if (el.type !== "image") continue;
			const img = inputs.images.get(el.asset);
			if (img) drawElement(ctx, el, img);
		}
		// v9: graphs and equations are content, in the same order as on screen (graphs under boxes, equations above).
		for (const el of elements) if (el.type === "graph") drawGraph(ctx, el);
		const label = inputs.boxLabel ?? ((b) => defaultBoxLabel(b));
		for (const el of elements) if (el.type === "box") drawBox(ctx, el, label);
		const numbers = inputs.equationNumbers ?? equationNumbers([page]);
		for (const el of elements) if (el.type === "equation") drawEquation(ctx, el, numbers.get(el.id));
		for (const el of elements) if (el.type === "text") drawTextElement(ctx, el);
		const clips = graphClips(inputs.clipElements ?? page.elements);
		for (const stroke of page.strokes) {
			if (stroke.hidden && !inputs.hiddenInk) continue;
			const path = strokePath2D(stroke, inputs.paths);
			if (!path) continue;
			const highlighter = stroke.tool === "highlighter";
			ctx.fillStyle = stroke.color;
			ctx.globalAlpha = highlighter ? HIGHLIGHTER_ALPHA : 1;
			ctx.globalCompositeOperation = highlighter ? "multiply" : "source-over";
			// v9: ink bound to a graph is clipped to its frame, as on screen.
			const clip = strokeClip(stroke, clips);
			if (clip) {
				ctx.save();
				ctx.beginPath();
				ctx.rect(clip.x, clip.y, clip.width, clip.height);
				ctx.clip();
				ctx.fill(path);
				ctx.restore();
			} else ctx.fill(path);
		}
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
		for (const el of elements) if (el.type === "marker") drawMarker(ctx, el);
	} finally {
		ctx.restore();
	}
}

/** The fill shape of a stroke, from `cache` when it has it. Null for a stroke with no shape. */
function strokePath2D(stroke: Stroke, cache: WeakMap<Stroke, Path2D> | undefined): Path2D | null {
	const have = cache?.get(stroke);
	if (have) return have;
	const d = strokeSvgPath(stroke);
	if (!d) return null;
	const path = new Path2D(d);
	cache?.set(stroke, path);
	return path;
}

function drawPaperLines(ctx: CanvasRenderingContext2D, page: Page): void {
	const { lines, dots } = paperPattern(page, { minX: 0, minY: 0, maxX: page.width, maxY: page.height });
	for (const kind of ["minor", "major", "margin"] as const) {
		ctx.strokeStyle = PAPER_COLORS[kind];
		ctx.lineWidth = PAPER_LINE_WIDTH[kind];
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
		ctx.fillStyle = PAPER_COLORS.dot;
		ctx.beginPath();
		for (const [x, y] of dots) {
			ctx.moveTo(x + PAPER_DOT_RADIUS, y);
			ctx.arc(x, y, PAPER_DOT_RADIUS, 0, Math.PI * 2);
		}
		ctx.fill();
	}
}
