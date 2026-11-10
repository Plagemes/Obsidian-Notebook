/**
 * 0.29 (#248) Figure captions and numbering. Pure (no DOM, no 'obsidian') and format-neutral: a caption is an ordinary text box
 * whose text starts with a marker naming the picture (`{{figcap:<element id>}} words`, see ink/figure-text.ts) and a reference is a
 * text box holding `{{figref:<element id>}}`. Numbers are never stored: they are worked out from the document every time.
 *
 * Numbering: only pictures that have a caption get a number ("Fig. 1", "Fig. 2", ...). Order is the reading order of the
 * notebook: pages in order, then inside a page top to bottom and left to right (the same order as the figures gallery, `collectFigures`).
 * So adding a captioned figure above, deleting one, or moving a page renumbers everything that follows, and every reference follows.
 */
import {
	captionText, DEFAULT_FIGURE_ABBR, figureTokens, frozenFigureSource, hasFigureTokens, parseCaption, referenceToken, withFigureScope,
	type FigureLabelSource,
} from "../ink/figure-text";
import { stampElement } from "../ink/date-stamp";
import { LINE_HEIGHT, type MeasureText } from "../ink/text-layout";
import { createId } from "./document";
import { collectFigures, indexesOf, type FigureEntry } from "./figures";
import type { Page, TextElement } from "./types";

const ID_OK = /^[A-Za-z0-9_-]{1,80}$/;

/** Whether a picture's element id can be written in a marker. */
export function markerSafeId(id: string): boolean {
	return ID_OK.test(id);
}

/** A text box that captions a picture. */
export interface CaptionBox {
	/** The picture it names and the words after the marker (may be empty). */
	figureId: string;
	text: string;
	/** The text box itself. */
	boxId: string;
	pageIndex: number;
	pageId: string;
	y: number;
	x: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Every caption box of the pages, in reading order. */
export function captionBoxes(pages: readonly Page[]): CaptionBox[] {
	const out: CaptionBox[] = [];
	pages.forEach((page, pageIndex) => {
		const here: CaptionBox[] = [];
		for (const e of page.elements ?? []) {
			if (e.type !== "text" || typeof e.text !== "string" || !hasFigureTokens(e.text)) continue;
			const c = parseCaption(e.text);
			if (c) here.push({ figureId: c.figureId, text: c.text, boxId: e.id, pageIndex, pageId: page.id, x: num(e.x), y: num(e.y) });
		}
		here.sort((a, b) => a.y - b.y || a.x - b.x);
		out.push(...here);
	});
	return out;
}

/** A picture with a caption, and its place in the numbering. */
export interface NumberedFigure {
	/** 1-based. */
	number: number;
	figure: FigureEntry;
	/** The caption boxes that name it (the first one gives the words shown in lists). */
	captions: CaptionBox[];
	/** The words of the first caption, one line. */
	caption: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The captioned pictures of the notebook with their numbers, in reading order. */
export function numberFigures(pages: readonly Page[]): NumberedFigure[] {
	const boxes = captionBoxes(pages);
	if (boxes.length === 0) return [];
	const byFigure = new Map<string, CaptionBox[]>();
	for (const b of boxes) {
		const list = byFigure.get(b.figureId);
		if (list) list.push(b);
		else byFigure.set(b.figureId, [b]);
	}
	const out: NumberedFigure[] = [];
	for (const figure of collectFigures(pages, indexesOf({ from: 0, to: pages.length }, pages.length))) {
		const captions = byFigure.get(figure.elementId);
		if (!captions) continue;
		out.push({ number: out.length + 1, figure, captions, caption: oneLine(captions.find((c) => c.text.trim() !== "")?.text ?? "") });
	}
	return out;
}

/** Figure element id -> number. */
export function numberMapOf(list: readonly NumberedFigure[]): Map<string, number> {
	return new Map(list.map((n) => [n.figure.elementId, n.number]));
}

/** Every reference marker of the pages, in reading order (a figure that is gone still has its references listed). */
export interface FigureReference {
	figureId: string;
	boxId: string;
	pageIndex: number;
}

export function referencesOf(pages: readonly Page[]): FigureReference[] {
	const out: FigureReference[] = [];
	pages.forEach((page, pageIndex) => {
		for (const e of page.elements ?? []) {
			if (e.type !== "text" || typeof e.text !== "string" || !hasFigureTokens(e.text)) continue;
			for (const t of figureTokens(e.text)) if (t.kind === "ref") out.push({ figureId: t.id, boxId: e.id, pageIndex });
		}
	});
	return out;
}

/** How many references point at each figure id that has none or no number: the ones that show "Fig. ?". */
export function brokenReferences(pages: readonly Page[], list: readonly NumberedFigure[] = numberFigures(pages)): FigureReference[] {
	const known = numberMapOf(list);
	return referencesOf(pages).filter((r) => !known.has(r.figureId));
}

/** The numbers of `pages` as they are now, frozen: later edits (or the view closing) change none of the answers. Review fix (F3). */
export function figureLabelSourceOf(pages: readonly Page[], abbr: string = DEFAULT_FIGURE_ABBR): FigureLabelSource {
	return frozenFigureSource(numberMapOf(numberFigures(pages)), abbr);
}

/**
 * Runs `fn` with the numbers of `pages` as the ONLY ones known to every text that is shown meanwhile (outputs of a notebook that is not
 * open in a view: companion note, Markdown, API PDF). Review fix (F1): the scope is exclusive, so an unknown figure is "Fig. ?" whatever
 * other notebooks are open, and the output depends on the document alone. `fn` must be synchronous: the numbers are forgotten when it returns.
 */
export function withFigureLabels<T>(pages: readonly Page[], fn: () => T, abbr: string = DEFAULT_FIGURE_ABBR): T {
	const hasMarkers = pages.some((p) => (p.elements ?? []).some((e) => e.type === "text" && typeof e.text === "string" && hasFigureTokens(e.text)));
	if (!hasMarkers) return fn();
	return withFigureScope(figureLabelSourceOf(pages, abbr), fn);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Building the boxes

const round2 = (v: number) => Math.round(v * 100) / 100;
/** Gap between a picture and its caption, pt. */
const CAPTION_GAP = 4;
/** The narrowest caption box, pt. */
const CAPTION_MIN_WIDTH = 90;

/**
 * Where a caption goes: directly under the picture, as wide as the picture (at least a readable width, kept inside the page). When
 * there is no room under it, directly above.
 */
export function captionSpot(figure: Pick<FigureEntry, "x" | "y" | "width" | "height">, page: Pick<Page, "width" | "height">, fontSize: number): { x: number; y: number; width: number } {
	const lineHeight = fontSize * LINE_HEIGHT;
	const width = Math.max(CAPTION_MIN_WIDTH, Math.min(figure.width, page.width));
	const x = Math.max(0, Math.min(figure.x, page.width - width));
	const below = figure.y + figure.height + CAPTION_GAP;
	const y = below + lineHeight <= page.height ? below : Math.max(0, figure.y - CAPTION_GAP - lineHeight);
	return { x: round2(x), y: round2(y), width: round2(width) };
}

/** A new caption box for a picture. */
export function captionElement(
	figure: FigureEntry, page: Pick<Page, "width" | "height">, text: string, fontSize: number, color: string, id: string = createId(),
): TextElement {
	const spot = captionSpot(figure, page, fontSize);
	return { id, type: "text", x: spot.x, y: spot.y, width: spot.width, text: captionText(figure.elementId, text), fontSize, color };
}

/** The stored text of a caption with other words (the marker of the same picture stays); null when the text is not a caption. */
export function withCaptionWords(oldText: string, words: string): string | null {
	const c = parseCaption(oldText);
	return c ? captionText(c.figureId, words) : null;
}

/** A text box holding a reference to a picture, one line, as wide as "Fig. 00", at the spot. */
export function referenceElement(
	figureId: string, page: Pick<Page, "width" | "height">, x: number, y: number, fontSize: number, color: string, measure?: MeasureText,
	abbr: string = DEFAULT_FIGURE_ABBR,
): TextElement {
	const box = stampElement(`${abbr} 000`, page, x, y, fontSize, color, measure);
	return { ...box, text: referenceToken(figureId) };
}
