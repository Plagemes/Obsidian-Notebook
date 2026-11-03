/** Pure logic of "New lecture" (no DOM, no 'obsidian'): the header text and the page that carries it. */
import { createId, createPage } from "../model/document";
import { freezeElement } from "../model/serialize";
import { estimateMeasure, layoutText } from "../ink/text-layout";
import { A4_HEIGHT, A4_WIDTH, type Page, type TextElement } from "../model/types";

export const HEADER_FONT_SIZE = 16;
export const HEADER_COLOR = "#1e1e1e";
/** Space around the header, pt. */
export const HEADER_MARGIN = 28;
export const MAX_TITLE_LENGTH = 200;
/** 0.14 (#438): the lines under the header (time slot, room, lecturer, slides). */
export const DETAILS_FONT_SIZE = 11;
export const DETAILS_COLOR = "#5f5f5f";
/** Gap between the header and the details box, pt. */
export const DETAILS_GAP = 6;

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

/** The slide or PDF the lecture follows: its name, the page in view and, for a PDF of the vault, its path (to link it). */
export interface SlideRef {
	name: string;
	/** 1-based page of the PDF, or null when only the file is known. */
	page: number | null;
	/** Vault path of a plain PDF: the line becomes a link `[[path#page=N]]`. */
	path?: string;
}

/** Everything a new lecture page can be filled in with (0.14, #438). Every field is optional. */
export interface LectureContext {
	/** `HH:MM` (the class's slot from the timetable). */
	start?: string;
	end?: string;
	room?: string;
	lecturer?: string;
	slide?: SlideRef | null;
}

/** `Slides: [[deck.pdf#page=12]]` for a PDF of the vault, `Slides: deck, slide 12` otherwise (text only, never a new format). */
export function slideLine(slide: SlideRef): string {
	const name = cleanTitle(slide.name);
	if (!name) return "";
	if (slide.path && !/[[\]|#^]/.test(slide.path)) return `Slides: [[${slide.path}${slide.page ? `#page=${slide.page}` : ""}]]`;
	return slide.page ? `Slides: ${name}, slide ${slide.page}` : `Slides: ${name}`;
}

/** The lines under the header: `09:00–11:00 · Room B2 · Prof. Rossi`, then the slide reference. Empty when there is nothing to say. */
export function lectureDetailsText(ctx: LectureContext): string {
	const slot = ctx.start && ctx.end ? `${ctx.start}–${ctx.end}` : ctx.start ?? "";
	const room = ctx.room ? cleanTitle(ctx.room) : "";
	const lecturer = ctx.lecturer ? cleanTitle(ctx.lecturer) : "";
	const first = [slot, room, lecturer].filter((x) => x !== "").join(" · ");
	const second = ctx.slide ? slideLine(ctx.slide) : "";
	return [first, second].filter((x) => x !== "").join("\n");
}

/** New lecture page: size, paper and infinite flag of `like`, the header text box at the top and, when `ctx` has anything to say, the details box under it. */
export function buildLecturePage(like: Page | undefined, title: string, date: Date, ctx?: LectureContext): Page {
	const size = like ? lecturePageSize(like) : { width: A4_WIDTH, height: A4_HEIGHT };
	const page = like ? createPage(size, { ...like.paper }) : createPage(size);
	if (like?.infinite) page.infinite = true;
	const width = Math.max(80, size.width - 2 * HEADER_MARGIN);
	const header: TextElement = {
		id: createId(),
		type: "text",
		x: HEADER_MARGIN,
		y: HEADER_MARGIN,
		width,
		text: lectureHeaderText(title, date),
		fontSize: HEADER_FONT_SIZE,
		color: HEADER_COLOR,
	};
	page.elements = [freezeElement(header)];
	const detailsText = ctx ? lectureDetailsText(ctx) : "";
	if (detailsText) {
		const headerLayout = layoutText(header.text, HEADER_FONT_SIZE, width, (s) => estimateMeasure(s, HEADER_FONT_SIZE));
		const details: TextElement = {
			id: createId(),
			type: "text",
			x: HEADER_MARGIN,
			y: Math.round((HEADER_MARGIN + headerLayout.height + DETAILS_GAP) * 100) / 100,
			width,
			text: detailsText,
			fontSize: DETAILS_FONT_SIZE,
			color: DETAILS_COLOR,
		};
		page.elements.push(freezeElement(details));
	}
	return page;
}

/**
 * The slide or PDF a new lecture page refers to (0.14, #438): the file shown beside the notes and its page in view, else the
 * PDF behind the page being looked at. Null when the notebook follows no slides.
 */
export function pickSlideRef(i: {
	pane: { open: boolean; file: { path: string; basename: string } | null } | null;
	paneSlide: number | null;
	page: Page | undefined;
	assets: Readonly<Record<string, { name: string }>> | undefined;
}): SlideRef | null {
	if (i.pane?.open && i.pane.file) return { name: i.pane.file.basename, page: i.paneSlide, path: i.pane.file.path };
	const bg = i.page?.background;
	if (bg?.kind === "pdf") {
		const name = (i.assets?.[bg.asset]?.name ?? "").replace(/\.pdf$/i, "");
		return name ? { name, page: bg.page } : null;
	}
	return null;
}
