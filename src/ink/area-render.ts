import type { AreaElement } from "../model/types";
import { inkAlpha, inkBlend } from "./stroke-shape";

/**
 * How an area highlighter (v23, roadmap #99) looks: the rectangle is painted with exactly the look of a highlighter stroke (its translucency
 * and its blend), so a notebook, its exports and its thumbnails agree. The canvas, the PNG raster and the previews of a selection use
 * `drawArea`; the SVG and the PDF exports write the same alpha and blend from `areaLook`. No 'obsidian' import, nothing allocated per call.
 */

/** Opacity and blend of an area in the day look: the highlighter's. */
export function areaLook(): { alpha: number; blend: "multiply" | "source-over" } {
	return { alpha: inkAlpha("highlighter"), blend: inkBlend("highlighter") };
}

export interface AreaPaint {
	/** The fill colour as it should be drawn (night mapping of the colour); default: the area's own. */
	colour?: string;
	/** Opacity; default: the highlighter's. */
	alpha?: number;
	/** Blend mode; default: the highlighter's (multiply). */
	blend?: GlobalCompositeOperation;
}

/** Fills the rectangle of `el` (page coordinates) on `ctx`. The caller saves and restores the context state (alpha and blend are set here). */
export function drawArea(ctx: CanvasRenderingContext2D, el: AreaElement, paint: AreaPaint = {}): void {
	const look = areaLook();
	ctx.fillStyle = paint.colour ?? el.color;
	ctx.globalAlpha = paint.alpha ?? look.alpha;
	ctx.globalCompositeOperation = paint.blend ?? look.blend;
	ctx.fillRect(el.x, el.y, el.width, el.height);
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = "source-over";
}
