// 0.15 (#75): automatic page header / footer. Pure layout and formatting (no 'obsidian'), plus one small canvas drawer.
// The line (notebook title, page date, page number) is never stored on the page: it is derived from the settings, the
// page position and the notebook, and painted by the view into the static (page) layer right after the paper, so it is
// redrawn only when that layer is, never per frame. Exports (PNG, PDF) get the same layout from `headerLayout`.
import type { Page, PageElement } from "../model/types";
import { formatStamp } from "./date-stamp";
import { pageTimes, type PageTimes } from "../model/page-times";
import { estimateMeasure, layoutText } from "./text-layout";

export const HEADER_MODES = ["off", "header", "footer"] as const;
export type HeaderMode = (typeof HEADER_MODES)[number];
export const HEADER_ALIGNS = ["left", "centre", "right"] as const;
export type HeaderAlign = (typeof HEADER_ALIGNS)[number];

export const isHeaderMode = (v: unknown): v is HeaderMode => typeof v === "string" && (HEADER_MODES as readonly string[]).includes(v);
export const isHeaderAlign = (v: unknown): v is HeaderAlign => typeof v === "string" && (HEADER_ALIGNS as readonly string[]).includes(v);

/** Font size (pt) of the line. */
export const HEADER_TEXT_SIZE = 9;
/** Height (pt) of the strip it lives in, from the page edge; an element that reaches into the strip takes the place. */
export const HEADER_BAND = 24;
/** Side margin (pt), and distance (pt) of the text's middle from the page edge. */
export const HEADER_SIDE = 28;
const MIDDLE = 13;
/** Colours: quiet grey on paper, light grey on the night paper. */
export const HEADER_COLOR_DAY = "#8a8f98";
export const HEADER_COLOR_NIGHT = "#8d93a0";
/** Separator between the fields of the line. */
export const HEADER_SEPARATOR = " · ";
/** Date format of the line (month name in the reader's language). */
export const HEADER_DATE_FORMAT = "D MMM YYYY";

export interface HeaderSettings {
	headerMode: HeaderMode;
	headerPageNumber: boolean;
	headerPageTotal: boolean;
	headerDate: boolean;
	headerTitle: boolean;
	headerAlign: HeaderAlign;
	headerInExport: boolean;
	/** v19 (#217): also show when the page was written (its start and end time), for the pages that have them. Absent: shown. */
	headerPageTimes?: boolean;
}

/** Date and time of the start and end of a page: `3 Jun 14:05`, `3 Jun 14:05 – 15:20`, `3 Jun 14:05 – 4 Jun 09:10`. */
export const PAGE_TIME_FORMAT = "D MMM HH:mm";

/** The start and end time of a page as one short text (the end only when it is a different minute); `locale` picks the month names. */
export function pageTimesText(times: PageTimes, locale: string): string {
	const start = new Date(times.startAt);
	const end = new Date(times.endAt);
	if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return "";
	const from = formatStamp(start, PAGE_TIME_FORMAT, locale);
	if (formatStamp(end, PAGE_TIME_FORMAT, locale) === from) return from;
	const sameDay = start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth() && start.getDate() === end.getDate();
	return `${from} – ${formatStamp(end, sameDay ? "HH:mm" : PAGE_TIME_FORMAT, locale)}`;
}

/** What the notebook contributes to the line. */
export interface HeaderNotebook {
	title: string;
	/** ISO time the notebook was created; used for the date because pages carry no timestamp of their own. */
	createdAt: string;
	locale: string;
}

export interface HeaderLayout {
	text: string;
	/** Text anchor x (pt, page coordinates) and the alignment it refers to. */
	x: number;
	align: HeaderAlign;
	/** Vertical middle of the text (pt). */
	y: number;
	size: number;
	/** Widest the text may be (pt); a longer line is squeezed to fit. */
	maxWidth: number;
	/** True: drawn at the bottom of the page. */
	footer: boolean;
}

/** The text of the line: `Title · 3 Jun 2026 · 3 / 12`; empty when no field is on or none has a value. */
export function headerText(s: HeaderSettings, nb: HeaderNotebook, index: number, count: number, times: PageTimes | null = null): string {
	const parts: string[] = [];
	const title = nb.title.replace(/\s+/g, " ").trim();
	if (s.headerTitle && title) parts.push(title);
	if (s.headerDate) {
		const d = new Date(nb.createdAt);
		if (Number.isFinite(d.getTime())) parts.push(formatStamp(d, HEADER_DATE_FORMAT, nb.locale));
	}
	if (s.headerPageNumber) parts.push(s.headerPageTotal && count > 0 ? `${index + 1} / ${count}` : String(index + 1));
	// v19: when the page was written; only a page that has times (none are invented for the others).
	if (times && s.headerPageTimes !== false) {
		const written = pageTimesText(times, nb.locale);
		if (written) parts.push(written);
	}
	return parts.join(HEADER_SEPARATOR);
}

/** Vertical extent [top, bottom] of an element, or null when it has none worth testing. */
function elementSpan(el: PageElement): [number, number] | null {
	if (el.type === "text") {
		const lay = layoutText(el.text, el.fontSize, Math.max(1, el.width), (str) => estimateMeasure(str, el.fontSize));
		return [el.y, el.y + lay.height];
	}
	const h = "height" in el && typeof el.height === "number" ? el.height : 0;
	const y = "y" in el && typeof el.y === "number" ? el.y : null;
	return y === null ? null : [y, y + h];
}

/** True when an element of the page reaches into the strip of `height` pt at its top (`footer` false) or bottom. */
export function bandTaken(page: Page, footer: boolean): boolean {
	for (const el of page.elements ?? []) {
		const span = elementSpan(el);
		if (!span) continue;
		if (footer ? span[1] > page.height - HEADER_BAND && span[0] < page.height : span[0] < HEADER_BAND && span[1] > 0) return true;
	}
	return false;
}

/**
 * Where and what to draw on `page` (0-based `index` of `count`), or null for nothing. Skipped on a page with a PDF or
 * picture background (unless it has margins, which leave the strip free), on an infinite page's footer (it grows), and
 * when an element already fills the strip, e.g. the lecture header (#210): then the other edge is tried before giving up.
 */
export function headerLayout(page: Page, index: number, count: number, s: HeaderSettings, nb: HeaderNotebook): HeaderLayout | null {
	if (s.headerMode === "off") return null;
	if (page.background && !page.margins) return null;
	const text = headerText(s, nb, index, count, pageTimes(page));
	if (text === "") return null;
	const wantFooter = s.headerMode === "footer";
	const usable = (footer: boolean) => !(footer && page.infinite) && !bandTaken(page, footer);
	let footer = wantFooter;
	if (!usable(footer)) {
		footer = !footer;
		if (!usable(footer)) return null;
	}
	const x = s.headerAlign === "left" ? HEADER_SIDE : s.headerAlign === "right" ? page.width - HEADER_SIDE : page.width / 2;
	return { text, x, align: s.headerAlign, y: footer ? page.height - MIDDLE : MIDDLE, size: HEADER_TEXT_SIZE, maxWidth: Math.max(40, page.width - 2 * HEADER_SIDE), footer };
}

/**
 * The header of a page for exports and printing (undefined: off, or kept out of exports). The page is found by its id, not by
 * object: the exports are handed live state views of the pages (a page with states is a different object with the same id),
 * and the number on the page is its place in the notebook, not in the exported selection.
 */
export function exportHeaderFor(pages: readonly Pick<Page, "id">[], s: HeaderSettings, nb: HeaderNotebook): ((page: Page) => HeaderLayout | null) | undefined {
	if (s.headerMode === "off" || !s.headerInExport) return undefined;
	const index = new Map(pages.map((p, i) => [p.id, i] as const));
	return (page) => {
		const i = index.get(page.id);
		return i === undefined ? null : headerLayout(page, i, pages.length, s, nb);
	};
}

/** Paints the line on a context already set to page coordinates (pt). One text draw; nothing is kept. */
export function drawHeader(ctx: CanvasRenderingContext2D, h: HeaderLayout, night = false): void {
	ctx.save();
	ctx.fillStyle = night ? HEADER_COLOR_NIGHT : HEADER_COLOR_DAY;
	ctx.font = `${h.size}px sans-serif`;
	ctx.textBaseline = "middle";
	ctx.textAlign = h.align === "centre" ? "center" : h.align;
	ctx.fillText(h.text, h.x, h.y, h.maxWidth);
	ctx.restore();
}
