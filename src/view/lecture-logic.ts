/** Pure logic of "New lecture" (no DOM, no 'obsidian'): the header text and the page that carries it. */
import { createId, createPage } from "../model/document";
import { freezeElement } from "../model/serialize";
import { A4_HEIGHT, A4_WIDTH, type Page, type TextElement } from "../model/types";

export const HEADER_FONT_SIZE = 16;
export const HEADER_COLOR = "#1e1e1e";
/** Space around the header, pt. */
export const HEADER_MARGIN = 28;
export const MAX_TITLE_LENGTH = 200;

const pad = (n: number) => String(n).padStart(2, "0");

/** Local date as `YYYY-MM-DD`. */
export function isoDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DD` (as typed in a date field) to a local date at noon; null when it is not a real calendar date. */
export function parseIsoDate(value: string): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const d = new Date(year, month - 1, day, 12, 0, 0);
	return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day ? d : null;
}

/** A title as one trimmed line: line breaks and runs of spaces collapse, length is capped. */
export function cleanTitle(raw: string): string {
	return raw.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH).trim();
}

/** Default course/title: the name of the notebook (file name without folder and extension). */
export function defaultLectureTitle(notebookPath: string | null | undefined): string {
	if (!notebookPath) return "";
	const name = notebookPath.slice(notebookPath.lastIndexOf("/") + 1);
	return cleanTitle(name.replace(/\.[^./]+$/, ""));
}

/** Text of the header: the title, then the date. An empty title leaves only the date. */
export function lectureHeaderText(title: string, date: Date): string {
	const clean = cleanTitle(title);
	return clean ? `${clean} — ${isoDate(date)}` : isoDate(date);
}

/**
 * Size of the new page: that of the page it follows. A grown infinite page starts again at the A4 proportions of
 * its width, so one long page does not make every lecture page that long.
 */
export function lecturePageSize(like: { width: number; height: number; infinite?: boolean }): { width: number; height: number } {
	if (!like.infinite) return { width: like.width, height: like.height };
	return { width: like.width, height: Math.round(like.width * (A4_HEIGHT / A4_WIDTH) * 100) / 100 };
}

/** New lecture page: size, paper and infinite flag of `like`, the header text box at the top. */
export function buildLecturePage(like: Page | undefined, title: string, date: Date): Page {
	const size = like ? lecturePageSize(like) : { width: A4_WIDTH, height: A4_HEIGHT };
	const page = like ? createPage(size, { ...like.paper }) : createPage(size);
	if (like?.infinite) page.infinite = true;
	const header: TextElement = {
		id: createId(),
		type: "text",
		x: HEADER_MARGIN,
		y: HEADER_MARGIN,
		width: Math.max(80, size.width - 2 * HEADER_MARGIN),
		text: lectureHeaderText(title, date),
		fontSize: HEADER_FONT_SIZE,
		color: HEADER_COLOR,
	};
	page.elements = [freezeElement(header)];
	return page;
}
