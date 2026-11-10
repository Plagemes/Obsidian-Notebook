/**
 * Live lecture bar, pure part (0.28 livelecture, roadmap #132): the elapsed timer and the timestamped marks. Pure: no 'obsidian'.
 *
 * An "important moment" is stored where page bookmarks already keep text, with no format change: the title of the page's bookmark
 * (`meta.bookmarkInfo[pageId].title`) gets a stamp such as "★ 12:34" (minutes:seconds since the lecture began, hours when it
 * runs past one). Several moments on one page are joined by " · ". A title the reader typed is kept in front of the stamps.
 * The end-of-lecture panel reads the stamps back from the titles (`collectLiveMarks`), so the list survives a restart.
 */
import { MAX_BOOKMARK_TITLE } from "../model/bookmarks";
import type { Page } from "../model/types";

export const MARK_GLYPH = "★";
export const MARK_SEPARATOR = " · ";

/** Whole seconds elapsed from `startMs` to `nowMs` (never negative, never fractional). */
export function elapsedSeconds(startMs: number, nowMs: number): number {
	if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return 0;
	return Math.max(0, Math.floor((nowMs - startMs) / 1000));
}

/** "12:34" under one hour, "1:02:03" from one hour on. */
export function formatElapsed(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const two = (n: number): string => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

/** The stamp of one moment: "★ 12:34". */
export function markLabel(totalSeconds: number): string {
	return `${MARK_GLYPH} ${formatElapsed(totalSeconds)}`;
}

/** Seconds of a "12:34" / "1:02:03" time, or null when it is not one. */
export function parseElapsed(text: string): number | null {
	const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/.exec(text);
	if (!m) return null;
	const minutes = Number(m[2]);
	const seconds = Number(m[3]);
	if (seconds > 59) return null;
	if (m[1] !== undefined && minutes > 59) return null;
	return (m[1] !== undefined ? Number(m[1]) * 3600 : 0) + minutes * 60 + seconds;
}

const STAMP_RE = /★ ((?:\d{1,3}:)?\d{1,2}:\d{2})(?!\d)/g;

/** The stamps found in a bookmark title, in order: their label and seconds. */
export function parseMarks(title: string | undefined): Array<{ label: string; seconds: number }> {
	const out: Array<{ label: string; seconds: number }> = [];
	if (!title) return out;
	for (const m of title.matchAll(STAMP_RE)) {
		const seconds = parseElapsed(m[1]!);
		if (seconds !== null) out.push({ label: `${MARK_GLYPH} ${m[1]!}`, seconds });
	}
	return out;
}

/**
 * The title with `label` added: a new title is just the label; an existing one gets it after " · ". An identical stamp is not
 * added twice. The result fits the bookmark title limit by dropping the oldest stamps first, never the reader's own text.
 */
export function addMarkToTitle(title: string | undefined, label: string): string {
	const base = (title ?? "").replace(/\s+/g, " ").trim();
	if (!base) return label;
	if (parseMarks(base).some((m) => m.label === label)) return base;
	let next = `${base}${MARK_SEPARATOR}${label}`;
	if (next.length <= MAX_BOOKMARK_TITLE) return next;
	// Too long: drop the oldest stamps until it fits (the label itself always stays).
	let rest = base;
	for (const stamp of parseMarks(base)) {
		rest = rest.replace(stamp.label, "").replace(/(?:^|\s)·(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
		next = rest ? `${rest}${MARK_SEPARATOR}${label}` : label;
		if (next.length <= MAX_BOOKMARK_TITLE) return next;
	}
	return label;
}

export interface LiveMark {
	pageId: string;
	pageIndex: number;
	label: string;
	seconds: number;
}

/**
 * Every stamped moment on pages `from` (included) to `to` (excluded), page by page and in time order within a page.
 * `info` is `meta.bookmarkInfo`; only pages that are still bookmarked count (`bookmarks`).
 */
export function collectLiveMarks(
	pages: readonly Pick<Page, "id">[],
	bookmarks: readonly string[],
	info: Readonly<Record<string, { title?: string }>> | undefined,
	range: { from: number; to: number },
): LiveMark[] {
	const out: LiveMark[] = [];
	const marked = new Set(bookmarks);
	for (let i = Math.max(0, range.from); i < Math.min(pages.length, range.to); i++) {
		const page = pages[i]!;
		if (!marked.has(page.id) || !info || !Object.prototype.hasOwnProperty.call(info, page.id)) continue;
		const stamps = parseMarks(info[page.id]!.title).sort((a, b) => a.seconds - b.seconds);
		for (const s of stamps) out.push({ pageId: page.id, pageIndex: i, label: s.label, seconds: s.seconds });
	}
	return out;
}

/** Where the elapsed time starts counting: the class's start when it already began, else now. */
export function lectureStart(classStartsAt: number | null, nowMs: number): number {
	return classStartsAt !== null && classStartsAt <= nowMs ? classStartsAt : nowMs;
}
