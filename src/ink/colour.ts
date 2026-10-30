// Free colour picker and style eyedropper logic (roadmap 7 and 68). Pure: no DOM, no 'obsidian'.
// Colours are "#rrggbb" strings everywhere (the document format and the settings store nothing else).
import type { Stroke } from "../model/types";
import { pointSegmentDistance } from "./hit-test";

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** Hue 0-360, saturation and value 0-1. */
export interface Hsv {
	h: number;
	s: number;
	v: number;
}

/** How many custom colours the settings remember. */
export const RECENT_COLOURS_MAX = 12;

/** "#rrggbb" (lower case) for "#rgb", "rgb", "#RRGGBB" or "RRGGBB"; null for anything else. */
export function normaliseHex(input: string): string | null {
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
	if (!m) return null;
	const h = m[1]!.toLowerCase();
	return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
}

const byte = (v: number): number => Math.min(255, Math.max(0, Math.round(Number.isFinite(v) ? v : 0)));

export function hexToRgb(hex: string): Rgb | null {
	const n = normaliseHex(hex);
	if (!n) return null;
	return { r: parseInt(n.slice(1, 3), 16), g: parseInt(n.slice(3, 5), 16), b: parseInt(n.slice(5, 7), 16) };
}

export function rgbToHex({ r, g, b }: Rgb): string {
	return `#${[r, g, b].map((v) => byte(v).toString(16).padStart(2, "0")).join("")}`;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
	const rn = byte(r) / 255, gn = byte(g) / 255, bn = byte(b) / 255;
	const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
	const d = max - min;
	let h = 0;
	if (d > 0) {
		if (max === rn) h = ((gn - bn) / d) % 6;
		else if (max === gn) h = (bn - rn) / d + 2;
		else h = (rn - gn) / d + 4;
		h *= 60;
		if (h < 0) h += 360;
	}
	return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
	const hh = ((((Number.isFinite(h) ? h : 0) % 360) + 360) % 360) / 60;
	const sat = Math.min(1, Math.max(0, s)), val = Math.min(1, Math.max(0, v));
	const c = val * sat;
	const x = c * (1 - Math.abs((hh % 2) - 1));
	const m = val - c;
	const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
	return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255) };
}

export function hexToHsv(hex: string): Hsv | null {
	const rgb = hexToRgb(hex);
	return rgb ? rgbToHsv(rgb) : null;
}

export function hsvToHex(hsv: Hsv): string {
	return rgbToHex(hsvToRgb(hsv));
}

/** A custom colour goes first in the list, once (case-insensitive), at most `max` kept. An invalid colour changes nothing. */
export function rememberColour(recent: readonly string[], colour: string, max = RECENT_COLOURS_MAX): string[] {
	const c = normaliseHex(colour);
	if (!c) return [...recent];
	return [c, ...recent.filter((r) => r.toLowerCase() !== c)].slice(0, max);
}

/** The recent list as read from the saved settings: valid, lower case, no duplicates, at most `max`. */
export function normaliseRecentColours(raw: unknown, max = RECENT_COLOURS_MAX): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		const c = typeof item === "string" ? normaliseHex(item) : null;
		if (c && !out.includes(c)) out.push(c);
		if (out.length >= max) break;
	}
	return out;
}

/**
 * The pixel of a canvas under a point. `rect` is the canvas's box on screen (CSS px), `canvas` its bitmap size: the
 * ratio of the two is the device pixel ratio times any zoom, so a 2.625 dpr tablet and a CSS-scaled canvas read the
 * right pixel. null when the point is outside the canvas or the box is empty.
 */
export function canvasPixelAt(
	rect: { left: number; top: number; width: number; height: number }, canvas: { width: number; height: number }, clientX: number, clientY: number,
): [number, number] | null {
	if (!(rect.width > 0) || !(rect.height > 0)) return null;
	const x = Math.floor((clientX - rect.left) * (canvas.width / rect.width));
	const y = Math.floor((clientY - rect.top) * (canvas.height / rect.height));
	if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
	return [x, y];
}

/** Distance (pt) from a page point to the centre line of a stroke. */
export function strokeDistance(stroke: Stroke, x: number, y: number): number {
	const pts = stroke.points;
	if (pts.length === 0) return Infinity;
	if (pts.length === 1) return Math.hypot(x - pts[0]![0], y - pts[0]![1]);
	let best = Infinity;
	for (let i = 1; i < pts.length; i++) {
		const [ax, ay] = pts[i - 1]!;
		const [bx, by] = pts[i]!;
		const d = pointSegmentDistance(x, y, ax, ay, bx, by);
		if (d < best) best = d;
	}
	return best;
}

/**
 * The stroke a tap at page point (x, y) means, or null. `tolerance` (pt) is the slack around the drawn ink for a
 * finger or a pen tip that is a little off. A stroke whose ink is under the point wins over one that is only near;
 * among those under it the topmost (drawn last) wins; among near ones the closest does.
 */
export function pickStrokeAt(strokes: readonly Stroke[], x: number, y: number, tolerance: number): Stroke | null {
	let best: Stroke | null = null;
	let bestCovered = false;
	let bestGap = Infinity;
	for (const s of strokes) {
		const d = strokeDistance(s, x, y);
		const half = s.width / 2;
		if (!(d <= half + Math.max(0, tolerance))) continue;
		const covered = d <= half;
		const gap = Math.max(0, d - half);
		// Later strokes are on top: on a tie they replace the earlier one.
		if (!best || (covered && !bestCovered) || (covered === bestCovered && (covered || gap <= bestGap))) {
			best = s;
			bestCovered = covered;
			bestGap = gap;
		}
	}
	return best;
}

/** What taking a stroke's style changes in the toolbar. A shape stroke is taken as a pen stroke (its kind is not stored). */
export type StrokeStyle =
	| { tool: "pen"; penColor: string; penWidth: number }
	| { tool: "highlighter"; highlighterColor: string; highlighterWidth: number };

const MIN_WIDTH = 0.1;
const MAX_WIDTH = 80;

export function styleOfStroke(stroke: Pick<Stroke, "tool" | "color" | "width">): StrokeStyle {
	const colour = normaliseHex(stroke.color) ?? "#1e1e1e";
	const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number.isFinite(stroke.width) ? stroke.width : 1)) * 100) / 100;
	if (stroke.tool === "highlighter") return { tool: "highlighter", highlighterColor: colour, highlighterWidth: width };
	return { tool: "pen", penColor: colour, penWidth: width };
}

/** Which toolbar colour a tool edits: the eraser's own when it is limited to one colour, the highlighter's, else the pen's. */
export function colourTarget(tool: string, eraserFilter: string): "pen" | "highlighter" | "eraser" {
	if (tool === "eraser") return eraserFilter === "color" ? "eraser" : "pen";
	return tool === "highlighter" ? "highlighter" : "pen";
}

/**
 * The toolbar change that sets the ink colour to `hex` for the tool in use. A tool without a colour of its own (lasso,
 * space, the eraser that is not filtering by colour) switches to the pen, as the radial colour ring always did.
 */
export function colourPatch(tool: string, eraserFilter: string, hex: string):
	{ penColor: string } | { highlighterColor: string } | { eraserColor: string } | { tool: "pen"; penColor: string } {
	switch (tool) {
		case "highlighter": return { highlighterColor: hex };
		case "pen":
		case "shape":
		case "text": return { penColor: hex };
		case "eraser": return eraserFilter === "color" ? { eraserColor: hex } : { tool: "pen", penColor: hex };
		default: return { tool: "pen", penColor: hex };
	}
}

/** The colour the picker starts from for the tool in use. */
export function currentColour(s: { tool: string; eraserFilter: string; penColor: string; highlighterColor: string; eraserColor: string }): string {
	const target = colourTarget(s.tool, s.eraserFilter);
	return target === "eraser" ? s.eraserColor : target === "highlighter" ? s.highlighterColor : s.penColor;
}
