// wave 0.9 (382): draws one page on a canvas at a given scale, for the PNG images of the Markdown export. Same look as the
// PDF and SVG exports: white sheet, background, paper, pictures, boxes, text, ink, markers; never the night-mode colours,
// never hidden ink unless the caller says so. The caller owns the canvas and the bitmaps (no 'obsidian' import).
import { backgroundRect } from "../model/margins";
import type { Page } from "../model/types";
import { PAPER_DOT_RADIUS, PAPER_LINE_WIDTH } from "./export-svg";
import { layerFlags, type ExportLayers } from "./export-layers";
import { defaultBoxLabel, drawBox, drawMarker, type BoxLabel } from "./marker-render";
import { PAPER_COLORS, paperPattern } from "./paper";
import { drawElement, drawTextElement } from "./renderer";
import { drawEquation, drawGraph } from "./math-render";
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
}

/** Paints `page` on `ctx` (a canvas of `page.width × scale` by `page.height × scale` pixels). */
export function drawPageRaster(ctx: CanvasRenderingContext2D, page: Page, scale: number, inputs: RasterInputs): void {
	const flags = layerFlags(inputs.layers);
	ctx.save();
	try {
		ctx.setTransform(scale, 0, 0, scale, 0, 0);
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
		const clips = graphClips(page.elements);
		for (const stroke of page.strokes) {
			if (stroke.hidden && !inputs.hiddenInk) continue;
			const d = strokeSvgPath(stroke);
			if (!d) continue;
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
				ctx.fill(new Path2D(d));
				ctx.restore();
			} else ctx.fill(new Path2D(d));
		}
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
		for (const el of elements) if (el.type === "marker") drawMarker(ctx, el);
	} finally {
		ctx.restore();
	}
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
