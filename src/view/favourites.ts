// Favourite pens and eraser size: pure logic (no 'obsidian'), unit-tested.

export type FavouriteTool = "pen" | "highlighter";

/** One saved pen: tool + colour + width (pt). */
export interface FavouritePen {
	tool: FavouriteTool;
	color: string;
	width: number;
}

export const FAVOURITE_SLOTS = 6;

export const DEFAULT_FAVOURITES: readonly FavouritePen[] = [
	{ tool: "pen", color: "#1e1e1e", width: 2 },
	{ tool: "pen", color: "#1d4ed8", width: 2 },
	{ tool: "pen", color: "#dc2626", width: 2 },
	{ tool: "pen", color: "#15803d", width: 1.2 },
	{ tool: "highlighter", color: "#facc15", width: 14 },
	{ tool: "highlighter", color: "#4ade80", width: 14 },
];

/** The part of the toolbar state that a favourite reads and writes. */
export interface PenState {
	tool: string;
	penColor: string;
	penWidth: number;
	highlighterColor: string;
	highlighterWidth: number;
}

const COLOR = /^#[0-9a-f]{6}$/i;

function validPen(v: unknown): FavouritePen | null {
	if (typeof v !== "object" || v === null) return null;
	const o = v as Record<string, unknown>;
	if (o.tool !== "pen" && o.tool !== "highlighter") return null;
	if (typeof o.color !== "string" || !COLOR.test(o.color)) return null;
	if (typeof o.width !== "number" || !Number.isFinite(o.width) || o.width <= 0 || o.width > 100) return null;
	return { tool: o.tool, color: o.color.toLowerCase(), width: o.width };
}

/** Always returns exactly FAVOURITE_SLOTS pens; bad or missing entries fall back to the default of their slot. */
export function normaliseFavourites(data: unknown): FavouritePen[] {
	const list = Array.isArray(data) ? data : [];
	return DEFAULT_FAVOURITES.map((fallback, i) => validPen(list[i]) ?? { ...fallback });
}

/** The pen that is selected right now (a highlighter, or else the pen colour and width). */
export function captureFavourite(s: PenState): FavouritePen {
	return s.tool === "highlighter"
		? { tool: "highlighter", color: s.highlighterColor.toLowerCase(), width: s.highlighterWidth }
		: { tool: "pen", color: s.penColor.toLowerCase(), width: s.penWidth };
}

/** The toolbar patch that selects a favourite. */
export function favouritePatch(fav: FavouritePen): Partial<PenState> {
	return fav.tool === "highlighter"
		? { tool: "highlighter", highlighterColor: fav.color, highlighterWidth: fav.width }
		: { tool: "pen", penColor: fav.color, penWidth: fav.width };
}

export function sameFavourite(a: FavouritePen, b: FavouritePen): boolean {
	return a.tool === b.tool && a.color.toLowerCase() === b.color.toLowerCase() && a.width === b.width;
}

/** Index of the slot holding the pen that is selected now, or -1. */
export function activeFavourite(favs: readonly FavouritePen[], s: PenState): number {
	if (s.tool !== "pen" && s.tool !== "highlighter") return -1;
	const now = captureFavourite(s);
	return favs.findIndex((f) => sameFavourite(f, now));
}

/** A copy of the list with one slot replaced; an out-of-range slot changes nothing. */
export function withFavourite(favs: readonly FavouritePen[], slot: number, pen: FavouritePen): FavouritePen[] {
	const out = favs.map((f) => ({ ...f }));
	if (Number.isInteger(slot) && slot >= 0 && slot < FAVOURITE_SLOTS) out[slot] = { ...pen };
	return out;
}

// --- eraser size ---

/** Eraser radius presets, CSS px. The default equals the fixed radius of earlier versions. */
export const ERASER_SIZES = [5, 10, 16, 24, 36] as const;
export const DEFAULT_ERASER_SIZE = 10;

export function normaliseEraserSize(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v >= 2 && v <= 100 ? v : DEFAULT_ERASER_SIZE;
}

/** The next larger (1) or smaller (-1) preset; stays put at the ends. */
export function stepEraserSize(current: number, direction: 1 | -1): number {
	const sizes = ERASER_SIZES as readonly number[];
	if (direction > 0) return sizes.find((s) => s > current) ?? sizes[sizes.length - 1]!;
	for (let i = sizes.length - 1; i >= 0; i--) if (sizes[i]! < current) return sizes[i]!;
	return sizes[0]!;
}

/** Eraser radius in page units (pt) at the given zoom. */
export function eraserRadiusPt(sizePx: number, scale: number): number {
	return normaliseEraserSize(sizePx) / (scale > 0 ? scale : 1);
}
