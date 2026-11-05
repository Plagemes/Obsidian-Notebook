import { createId } from "../model/document";
import { AddElement, Batch } from "../model/history";
import { freezeStroke } from "../model/serialize";
import type { NotebookDocument, Page, PageElement, Stroke, TextElement } from "../model/types";
import { instantiateClip, pasteCommand, pasteOffset, type ClipContent } from "./clipboard";
import { stampElement } from "./date-stamp";
import { estimateMeasure, type MeasureText } from "./text-layout";

/**
 * Symbols (roadmap 212): a symbol is a small personal stamp (ink/stamps.ts, the same vault store and format) that is
 * placed at the size of the pen, or a typographic character placed as a text box. Pure: the strip
 * (view/symbol-strip.ts) only asks for a plan.
 */

/** A saved selection is a symbol when neither side is longer than this (pt). */
export const MAX_SYMBOL_SIDE = 200;
/** A symbol is never scaled by more than these factors. */
export const MIN_SYMBOL_SCALE = 0.1;
export const MAX_SYMBOL_SCALE = 4;

export function isSymbolSized(clip: Pick<ClipContent, "bounds">): boolean {
	const w = clip.bounds.maxX - clip.bounds.minX;
	const h = clip.bounds.maxY - clip.bounds.minY;
	return (w > 0 || h > 0) && w <= MAX_SYMBOL_SIDE && h <= MAX_SYMBOL_SIDE;
}

/** Height (pt) a symbol takes on the page: one text line of the current text size. */
export function symbolLineHeight(textSize: number): number {
	return Math.max(8, textSize * 1.25);
}

/** Factor that brings the longer side of a symbol to `lineHeight`, within the limits. */
export function symbolScale(bounds: { minX: number; minY: number; maxX: number; maxY: number }, lineHeight: number): number {
	const side = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
	if (!(side > 0) || !(lineHeight > 0)) return 1;
	return Math.min(MAX_SYMBOL_SCALE, Math.max(MIN_SYMBOL_SCALE, lineHeight / side));
}

export interface SymbolStyle {
	color: string;
	/** Pen width (pt): the symbol's lines get it after scaling. */
	width: number;
	textSize: number;
}

/**
 * The symbol with the pen's colour and width, ready to be scaled by `scale`: every stroke gets width/scale (so it
 * ends up at the pen width), and the strokes of a symbol with two or more belong to one new group (selected and moved
 * as one). Images are not part of a symbol.
 */
export function restyleSymbol(clip: ClipContent, style: Pick<SymbolStyle, "color" | "width">, scale: number): ClipContent {
	const group = clip.strokes.length >= 2 ? createId() : undefined;
	const width = Math.max(0.1, style.width / scale);
	const strokes: Stroke[] = clip.strokes.map((s) => {
		const { group: _g, ...rest } = s;
		void _g;
		return freezeStroke({
			...rest, ...(s.tool === "highlighter" ? {} : { color: style.color, width }), ...(group === undefined ? {} : { group }),
		});
	});
	const elements = clip.elements.filter((e) => e.type !== "image");
	return { ...clip, strokes, elements };
}

export interface SymbolPlacement {
	command: Batch;
	strokes: Stroke[];
	elements: PageElement[];
}

/** Places a saved symbol on `page`, centred at `centre`: pen-sized, fresh ids, ONE undo step (null when it has no content). */
export function planSymbolPlacement(
	clip: ClipContent, doc: Readonly<NotebookDocument>, page: Page, centre: readonly [number, number], style: SymbolStyle,
	measure: MeasureText = estimateMeasure,
): SymbolPlacement | null {
	void doc;
	const scale = symbolScale(clip.bounds, symbolLineHeight(style.textSize));
	const styled = restyleSymbol(clip, style, scale);
	if (styled.strokes.length === 0 && styled.elements.length === 0) return null;
	const [dx, dy] = pasteOffset(styled.bounds, page, centre, 0, scale);
	const made = instantiateClip(styled, dx, dy, undefined, measure, scale);
	return { command: pasteCommand(page, made.strokes, made.elements, [], "Place symbol"), strokes: made.strokes, elements: made.elements };
}

export interface GlyphPlacement {
	command: AddElement;
	element: TextElement;
}

/** Places a typographic character as a one-line text box centred at `centre` (one undo step). */
export function planGlyphPlacement(
	glyph: string, page: Page, centre: readonly [number, number], style: Pick<SymbolStyle, "color" | "textSize">, measure: MeasureText = estimateMeasure,
): GlyphPlacement | null {
	if (glyph === "") return null;
	const size = style.textSize;
	const probe = stampElement(glyph, page, 0, 0, size, style.color, measure);
	const el = stampElement(glyph, page, centre[0] - probe.width / 2, centre[1] - size * 0.7, size, style.color, measure);
	return { command: new AddElement(page.id, el, page.elements?.length ?? 0), element: el };
}
