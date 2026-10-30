// ui redesign: the radial dial's model: palettes, width scales, positions on the ring and the arc slider. Pure (no DOM,
// no 'obsidian'); the dial itself is view/radial-menu.ts.
import type { ToolId } from "./actions";

export type DialState = "main" | "color" | "width" | "tools" | "favourites" | "shapes" | "markers";

/** wave 0.8: what the dial's Markers ring places (marker kinds, then a structured box), with the badge glyph it shows. */
export const MARKER_RING: ReadonlyArray<readonly ["gap" | "question" | "important" | "critical" | "star" | "homework" | "box", string]> = [
	["gap", "…"], ["question", "?"], ["important", "!"], ["critical", "!!"], ["star", "★"], ["homework", "HW"], ["box", "▭"],
];

/** Diameter of the dial, CSS px. */
export const DIAL_SIZE = 264;
export const DIAL_RADIUS = DIAL_SIZE / 2;
/** Radius of the ring where the items of a state sit. */
export const RING_RADIUS = 98;

/** Twelve pen colours: the toolbar's nine, then brown, pink and teal. */
export const PEN_PALETTE = [
	"#1e1e1e", "#6b7280", "#1d4ed8", "#0891b2", "#15803d", "#ca8a04", "#ea580c", "#dc2626", "#9333ea", "#7c2d12", "#db2777", "#0f766e",
] as const;
/** Twelve highlighter colours: the toolbar's five, then softer ones. */
export const HIGHLIGHTER_PALETTE = [
	"#facc15", "#4ade80", "#f472b6", "#60a5fa", "#fb923c", "#a78bfa", "#22d3ee", "#f87171", "#a3e635", "#fde68a", "#d1d5db", "#2dd4bf",
] as const;

/** Widths offered by the arc slider (pen and shape widths in pt). */
export const PEN_STEPS = [0.5, 0.8, 1.2, 1.6, 2, 2.6, 3.2, 4, 5, 6.5, 8] as const;
export const HIGHLIGHTER_STEPS = [6, 8, 10, 12, 14, 17, 20, 24, 28] as const;
/** Eraser radius, CSS px (same presets as the toolbar). */
export const ERASER_STEPS = [5, 10, 16, 24, 36] as const;
/** Font size of new text boxes, pt (same presets as the toolbar). */
export const TEXT_STEPS = [10, 14, 20, 28] as const;

/** Which colour a tool uses: the pen colour (pen, shapes, text), the highlighter's, or none. */
export function colourSlot(tool: ToolId): "pen" | "highlighter" | null {
	if (tool === "highlighter") return "highlighter";
	if (tool === "pen" || tool === "shape" || tool === "text") return "pen";
	return null;
}

export function paletteFor(tool: ToolId): readonly string[] {
	return tool === "highlighter" ? HIGHLIGHTER_PALETTE : PEN_PALETTE;
}

/** Which size a tool's width bubble edits, with its steps; null when the tool has no size. */
export function widthScale(tool: ToolId): { field: "penWidth" | "highlighterWidth" | "eraserSize" | "textSize"; steps: readonly number[]; unit: "pt" | "px" } | null {
	switch (tool) {
		case "pen":
		case "shape":
			return { field: "penWidth", steps: PEN_STEPS, unit: "pt" };
		case "highlighter":
			return { field: "highlighterWidth", steps: HIGHLIGHTER_STEPS, unit: "pt" };
		case "eraser":
			return { field: "eraserSize", steps: ERASER_STEPS, unit: "px" };
		case "text":
			return { field: "textSize", steps: TEXT_STEPS, unit: "pt" };
		default:
			return null;
	}
}

/** Index of the step closest to `value`. */
export function nearestStep(steps: readonly number[], value: number): number {
	let best = 0;
	for (let i = 1; i < steps.length; i++) if (Math.abs(steps[i]! - value) < Math.abs(steps[best]! - value)) best = i;
	return best;
}

/** A width as the dial shows it: "2", "3.2", "0.5". */
export function formatWidth(value: number): string {
	return String(Math.round(value * 10) / 10);
}

/** Point at `deg` degrees clockwise from the top, `r` from (cx, cy). */
export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
	const a = (deg * Math.PI) / 180;
	return [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
}

/** Angle of (dx, dy) from the centre, degrees clockwise from the top, in (-180, 180]. */
export function angleOf(dx: number, dy: number): number {
	const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
	return deg <= -180 ? 180 : deg;
}

/** `count` angles spread evenly from `start` to `end` degrees (both included; one item sits in the middle). */
export function arcAngles(count: number, start: number, end: number): number[] {
	if (count <= 0) return [];
	if (count === 1) return [(start + end) / 2];
	return Array.from({ length: count }, (_, i) => start + ((end - start) * i) / (count - 1));
}

/** `count` angles all around the ring, the first at the top. */
export function ringAngles(count: number): number[] {
	return Array.from({ length: count }, (_, i) => (360 * i) / Math.max(1, count));
}

/** The arc of the width slider: from lower left, over the top, to lower right. */
export const SLIDER_START = -130;
export const SLIDER_END = 130;

/** The step of a slider of `count` steps along [start, end] under the angle `deg` (clamped to the ends). */
export function stepAtAngle(deg: number, count: number, start = SLIDER_START, end = SLIDER_END): number {
	if (count <= 1) return 0;
	const t = (Math.min(Math.max(deg, start), end) - start) / (end - start);
	return Math.round(t * (count - 1));
}

/** Radius (CSS px) of the dot of step `i` of `count`: growing from `min` to `max`. */
export function stepDotRadius(i: number, count: number, min = 3, max = 11): number {
	if (count <= 1) return max;
	return min + ((max - min) * i) / (count - 1);
}

/** Diameter (CSS px) of the dot in the width bubble for a width: readable at every size, never larger than the bubble. */
export function bubbleDot(tool: ToolId, value: number): number {
	if (tool === "eraser") return Math.max(6, Math.min(24, Math.round(value * 0.6)));
	if (tool === "text") return Math.max(6, Math.min(24, Math.round(value * 0.8)));
	if (tool === "highlighter") return Math.max(6, Math.min(24, Math.round(value * 0.8)));
	return Math.max(4, Math.min(24, Math.round(2 + value * 2.6)));
}

/** The pen case: the tools in the order they are laid out on the arc. */
export const PEN_CASE: readonly ToolId[] = ["pen", "highlighter", "eraser", "lasso", "shape", "text", "space"];
