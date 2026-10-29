import { getStroke, type StrokeOptions } from "perfect-freehand";
import type { Point, Tool } from "../model/types";

/** Pen v1 parameters (see docs/architecture.md §2). Changing them changes how existing files look. */
export const PEN_V1: Readonly<StrokeOptions> = {
	thinning: 0.6,
	smoothing: 0.5,
	streamline: 0.35,
	simulatePressure: false,
	start: { cap: true, taper: 0 },
	end: { cap: true, taper: 0 },
};

/** Highlighter (format v2): constant width, flat ends. Drawn translucent by the renderer. */
export const HIGHLIGHTER_V2: Readonly<StrokeOptions> = {
	thinning: 0,
	smoothing: 0.5,
	streamline: 0.35,
	simulatePressure: false,
	start: { cap: false, taper: 0 },
	end: { cap: false, taper: 0 },
};

/** Shape tool (format v4): constant width, no smoothing or streamlining (corners stay sharp), round caps. */
export const SHAPE_V4: Readonly<StrokeOptions> = {
	thinning: 0,
	smoothing: 0,
	streamline: 0,
	simulatePressure: false,
	start: { cap: true, taper: 0 },
	end: { cap: true, taper: 0 },
};

export const HIGHLIGHTER_ALPHA = 0.35;

/** Stroke outline (closed polygon) in page coordinates. */
export function strokeOutline(points: readonly Point[], width: number, complete = true, tool: Tool = "pen"): number[][] {
	const base = tool === "highlighter" ? HIGHLIGHTER_V2 : tool === "shape" ? SHAPE_V4 : PEN_V1;
	return getStroke(points as Point[], { ...base, size: width, last: complete });
}

/** Closed SVG path with quadratic curves through the outline midpoints. */
export function outlineToPath(outline: readonly number[][]): string {
	const n = outline.length;
	if (n === 0) return "";
	const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
	if (n < 3) {
		const [x, y] = outline[0]!;
		return `M${fmt(x!)} ${fmt(y!)}Z`;
	}
	const [x0, y0] = outline[0]!;
	const [x1, y1] = outline[1]!;
	let d = `M${fmt(x0!)} ${fmt(y0!)}Q${fmt(x1!)} ${fmt(y1!)} ${fmt((x1! + outline[2]![0]!) / 2)} ${fmt((y1! + outline[2]![1]!) / 2)}T`;
	for (let i = 2; i < n - 1; i++) {
		const [ax, ay] = outline[i]!;
		const [bx, by] = outline[i + 1]!;
		d += `${fmt((ax! + bx!) / 2)} ${fmt((ay! + by!) / 2)} `;
	}
	return d + "Z";
}

export function strokePath(points: readonly Point[], width: number, complete = true, tool: Tool = "pen"): string {
	return outlineToPath(strokeOutline(points, width, complete, tool));
}
