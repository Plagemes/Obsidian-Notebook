/**
 * "Copy to notebook…" with a link back (roadmap #186): the pure part. What the two small link chips say and where they sit on
 * a page. A chip is an ordinary text box whose whole text is one page link (`[[Notebook#p3&id=…|Copied from Notebook p.3]]`),
 * so the existing link machinery opens it, the document format does not change, and the companion note shows it like any
 * other text box. No 'obsidian', no DOM.
 */
import { linkMarkup, soleLink } from "../ink/link-text";
import { estimateMeasure, LINE_HEIGHT, textElementBounds, type MeasureText } from "../ink/text-layout";
import { t } from "../i18n";
import type { PageElement, TextElement } from "../model/types";
import { stablePageSubpath } from "../integration/page-links";

/** Chip text size (pt): small, it is a margin note and not content. */
export const CHIP_FONT_SIZE = 9;
/** Distance from the left edge of the page (pt). */
export const CHIP_LEFT = 28;
/** Distance from the top edge of the first chip (pt). */
export const CHIP_TOP = 10;
/** Gap between stacked chips (pt). */
const CHIP_GAP = 2;
/** Chips stack inside this band at the top of the page; the last one stays in it even when the band is full (pt). */
export const CHIP_BAND = 56;
const CHIP_COLOUR = "#6b7280";
const MIN_WIDTH = 60;

export type ChipKind = "from" | "to";

/** What a chip reads: "Copied from Physics p.3" / "Copied to Physics p.7". */
export function chipLabel(kind: ChipKind, notebook: string, page: number): string {
	return t(kind === "from" ? "copylink.from" : "copylink.to", { name: notebook, n: String(page) });
}

/** The text of a chip: one wikilink to page `page` (id `pageId`) of the notebook whose link text is `linktext`. */
export function chipText(kind: ChipKind, linktext: string, notebook: string, page: number, pageId: string): string {
	const target = `${linktext.replace(/[#|[\]\r\n]+/g, " ").trim()}${stablePageSubpath(page, pageId)}`;
	return linkMarkup(target, chipLabel(kind, notebook, page));
}

/** Text boxes that look like chips: a whole-text page link in the chip size, in the top band. */
function chipsOf(elements: readonly PageElement[]): TextElement[] {
	return elements.filter((e): e is TextElement => e.type === "text" && e.fontSize === CHIP_FONT_SIZE && e.y < CHIP_BAND && soleLink(e.text) !== null);
}

/** The elements without the link chips a page already carries (a copy must not keep the original's older chips: they would be misleading). */
export function withoutChips(elements: readonly PageElement[] | undefined): PageElement[] {
	const chips = new Set<PageElement>(chipsOf(elements ?? []));
	return (elements ?? []).filter((e) => !chips.has(e));
}

/** Whether the page already has a chip with exactly this text (copying twice must not stack the same chip). */
export function hasChip(elements: readonly PageElement[] | undefined, text: string): boolean {
	return (elements ?? []).some((e) => e.type === "text" && e.text === text);
}

/**
 * The chip for a page: left in the top margin, under the chips the page already has. Null when it already has this chip.
 * `measure` is the real text measure of the view (tests give a fixed pitch).
 */
export function planChip(
	id: string, text: string, alias: string, page: { width: number; elements?: readonly PageElement[] }, measure: MeasureText = estimateMeasure,
): TextElement | null {
	if (hasChip(page.elements, text)) return null;
	const maxWidth = Math.max(MIN_WIDTH, page.width - 2 * CHIP_LEFT);
	const width = Math.min(maxWidth, Math.max(MIN_WIDTH, Math.ceil(measure(alias, CHIP_FONT_SIZE)) + 4));
	let y = CHIP_TOP;
	for (const c of chipsOf(page.elements ?? [])) y = Math.max(y, textElementBounds(c, measure).maxY + CHIP_GAP);
	const el: TextElement = { id, type: "text", x: CHIP_LEFT, y, width, text, fontSize: CHIP_FONT_SIZE, color: CHIP_COLOUR };
	// The band is full: the chip still goes in, just above its lower edge, so it never lands in the middle of the page.
	if (y > CHIP_BAND) el.y = CHIP_BAND;
	return el;
}

/** Height of one chip line (pt), for the tests and for stacking. */
export const CHIP_LINE = CHIP_FONT_SIZE * LINE_HEIGHT;

/** The places the copies can go in a destination of `total` pages: the 0-based index they start at, from the start to the end. */
export function positionChoices(total: number): number[] {
	return Array.from({ length: Math.max(0, Math.floor(total)) + 1 }, (_, i) => i);
}

/** What the position `at` is called in the dialog. */
export function positionLabel(at: number, total: number): string {
	if (at <= 0) return t("copylink.pos.start");
	if (at >= total) return t("copylink.pos.end");
	return t("copylink.pos.after", { n: String(at) });
}

/** Why the dialog cannot go on yet, or null. */
export function copyBlocker(pages: number, dest: string | null, destReadable: boolean): "no-pages" | "no-notebook" | "reading" | null {
	if (pages === 0) return "no-pages";
	if (dest === null) return "no-notebook";
	return destReadable ? null : "reading";
}

export interface PairInput {
	/** The source pages that were copied, in source order, with their 1-based numbers there. */
	sources: ReadonlyArray<{ id: string; number: number; locked: boolean }>;
	/** Ids the copies got, same order. */
	copyIds: readonly string[];
	/** 1-based number of the first copy in the destination. */
	firstNumber: number;
	sourceName: string;
	destName: string;
	sourceLinktext: string;
	destLinktext: string;
}

export interface PagePair {
	sourceId: string;
	sourceNumber: number;
	sourceLocked: boolean;
	copyId: string;
	copyNumber: number;
	/** Text of the chip on the copy ("Copied from …"). */
	fromText: string;
	fromAlias: string;
	/** Text of the chip on the original ("Copied to …"). */
	toText: string;
	toAlias: string;
}

/** The two chips of every copied page. Pure; the caller puts them on the pages. */
export function planPairs(p: PairInput): PagePair[] {
	const out: PagePair[] = [];
	p.sources.forEach((s, i) => {
		const copyId = p.copyIds[i];
		if (copyId === undefined) return;
		const copyNumber = p.firstNumber + i;
		out.push({
			sourceId: s.id, sourceNumber: s.number, sourceLocked: s.locked, copyId, copyNumber,
			fromText: chipText("from", p.sourceLinktext, p.sourceName, s.number, s.id), fromAlias: chipLabel("from", p.sourceName, s.number),
			toText: chipText("to", p.destLinktext, p.destName, copyNumber, copyId), toAlias: chipLabel("to", p.destName, copyNumber),
		});
	});
	return out;
}

/**
 * The pairs whose original can get a "Copied to" chip. `now` maps the ids of the pages the source has now to whether each is
 * locked: a page that is gone is left out, a locked page refuses every edit and is only counted.
 */
export function reversible(pairs: readonly PagePair[], now: ReadonlyMap<string, boolean>): { go: PagePair[]; skippedLocked: number } {
	const go: PagePair[] = [];
	let skippedLocked = 0;
	for (const p of pairs) {
		const locked = now.get(p.sourceId);
		if (locked === undefined) continue;
		if (locked) skippedLocked++;
		else go.push(p);
	}
	return { go, skippedLocked };
}
