import { createId } from "../model/document";
import type { Page, TextElement } from "../model/types";
import { estimateMeasure, LINE_HEIGHT, type MeasureText } from "./text-layout";

/**
 * wave 0.10 (356): quick date and time stamp. Pure helpers: the format of the stamp, where it goes on the page and the
 * text box it becomes. The view only supplies the clock, the last pen position and the undo step.
 */

export const DEFAULT_STAMP_FORMAT = "YYYY-MM-DD HH:mm";
/** Longest format kept (a format is a few tokens; this only stops a pasted paragraph from becoming a setting). */
export const MAX_STAMP_FORMAT = 80;
/** Font size (pt) of a stamp when the text tool has none to offer. */
export const DEFAULT_STAMP_FONT_SIZE = 14;
/** A pen position older than this (ms) is not "where the pen is" any more: the stamp goes to the middle of the page. */
export const PEN_POSITION_MAX_AGE_MS = 5 * 60 * 1000;

const pad = (n: number, width = 2) => String(Math.trunc(n)).padStart(width, "0");

/**
 * Format tokens: YYYY YY (year), MMMM MMM MM M (month: name, short name, number), DD D (day of month), dddd ddd (weekday
 * name, short name), HH H (hour, 24 h), hh h (hour, 12 h), mm m (minute), ss s (second), A a (AM/PM). Text in square
 * brackets is copied as it is; any other character is copied too. `locale` only picks the language of month and weekday names.
 */
export function formatStamp(date: Date, format: string, locale = "en"): string {
	const names = (opts: Intl.DateTimeFormatOptions): string => {
		try {
			return new Intl.DateTimeFormat(locale, opts).format(date);
		} catch {
			return new Intl.DateTimeFormat("en", opts).format(date);
		}
	};
	const h24 = date.getHours();
	const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
	const tokens: Record<string, () => string> = {
		YYYY: () => pad(date.getFullYear(), 4),
		YY: () => pad(date.getFullYear() % 100),
		MMMM: () => names({ month: "long" }),
		MMM: () => names({ month: "short" }),
		MM: () => pad(date.getMonth() + 1),
		M: () => String(date.getMonth() + 1),
		DD: () => pad(date.getDate()),
		D: () => String(date.getDate()),
		dddd: () => names({ weekday: "long" }),
		ddd: () => names({ weekday: "short" }),
		HH: () => pad(h24),
		H: () => String(h24),
		hh: () => pad(h12),
		h: () => String(h12),
		mm: () => pad(date.getMinutes()),
		m: () => String(date.getMinutes()),
		ss: () => pad(date.getSeconds()),
		s: () => String(date.getSeconds()),
		A: () => (h24 < 12 ? "AM" : "PM"),
		a: () => (h24 < 12 ? "am" : "pm"),
	};
	const re = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a/g;
	return format.replace(re, (match, literal: string | undefined) => (literal !== undefined ? literal : tokens[match]!()));
}

/** A saved format: trimmed, limited, and the default when nothing usable is left or it would stamp an empty text. */
export function cleanStampFormat(raw: unknown, date: Date = new Date(2026, 9, 29, 14, 5, 9)): string {
	if (typeof raw !== "string") return DEFAULT_STAMP_FORMAT;
	const format = raw.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_STAMP_FORMAT);
	return format === "" || formatStamp(date, format).trim() === "" ? DEFAULT_STAMP_FORMAT : format;
}

export interface PenPosition {
	pageIndex: number;
	/** Page coordinates. */
	x: number;
	y: number;
	/** When it was noted (ms, same clock as `now`). */
	at: number;
}

/**
 * Where a stamp goes: the last place the pen touched when it was on a page that still exists and not too long ago, else
 * the middle of the page in view. Page coordinates of that page.
 */
export function stampSpot(
	pen: PenPosition | null, now: number, pages: ReadonlyArray<Pick<Page, "width" | "height">>, viewPage: number,
): { pageIndex: number; x: number; y: number } | null {
	if (pen && pages[pen.pageIndex] && now - pen.at <= PEN_POSITION_MAX_AGE_MS && now >= pen.at) {
		return { pageIndex: pen.pageIndex, x: pen.x, y: pen.y };
	}
	const page = pages[viewPage] ?? pages[0];
	if (!page) return null;
	const index = pages[viewPage] ? viewPage : 0;
	return { pageIndex: index, x: page.width / 2, y: page.height / 2 };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The text box of a stamp: one line, as wide as the text needs (never wider than the page minus the margins), its
 * left-top corner at the spot and moved back inside the page when it would stick out.
 */
export function stampElement(
	text: string, page: Pick<Page, "width" | "height">, x: number, y: number, fontSize: number, color: string,
	measure: MeasureText = estimateMeasure,
): TextElement {
	const margin = 8;
	const natural = Math.ceil(measure(text, fontSize)) + 8;
	const width = Math.max(40, Math.min(natural, Math.max(40, page.width - margin * 2)));
	const height = fontSize * LINE_HEIGHT;
	const left = Math.max(0, Math.min(x, page.width - width - margin));
	const top = Math.max(0, Math.min(y, page.height - height - margin));
	return { id: createId(), type: "text", x: round2(left), y: round2(top), width: round2(width), text, fontSize, color };
}
