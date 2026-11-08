/**
 * Automatic lecture header (0.22, roadmap #210): course, lecturer, room, date and start time of the class in progress, written
 * as small text boxes in a fresh group at the top of the page you are writing on. Pure rules, no DOM and no 'obsidian'.
 *
 * Nothing here touches the document: `planLectureHeader` answers with the elements to add (or why nothing is added) and the
 * view adds them in one History step. The header only goes where the page is empty: it never overlaps ink or an element.
 */
import { elementBounds } from "../ink/elements";
import type { BBox } from "../ink/hit-test";
import { strokeBounds } from "../ink/hit-test";
import { estimateMeasure, layoutText, type MeasureText } from "../ink/text-layout";
import { createId } from "../model/document";
import { freezeElement } from "../model/serialize";
import type { Page, TextElement } from "../model/types";
import { lectureHeaderText } from "../view/lecture-logic";
import type { LectureClass } from "./lecture-mode";
import { classForNotebook, classesAt, classesOn, parseTime, type ClassEntry, type Timetable } from "./schedule";

/** `off`: never on its own (the command still works); `ask`: a chip offers it; `auto`: it is added by itself. */
export const LECTURE_HEADER_MODES = ["off", "ask", "auto"] as const;
export type LectureHeaderMode = (typeof LECTURE_HEADER_MODES)[number];

/** The course is always written; these are the other fields. */
export interface HeaderFields {
	lecturer: boolean;
	room: boolean;
	date: boolean;
	time: boolean;
}

export const DEFAULT_HEADER_FIELDS: Readonly<HeaderFields> = { lecturer: true, room: true, date: true, time: true };

export const HEADER_TITLE_SIZE = 15;
export const HEADER_DETAILS_SIZE = 11;
export const HEADER_TITLE_COLOR = "#1e1e1e";
export const HEADER_DETAILS_COLOR = "#5f5f5f";
/** Distance from the page edge and between the two boxes, pt. */
export const HEADER_EDGE = 28;
export const HEADER_GAP = 4;
/** Clear space kept around the header, pt. */
export const HEADER_CLEARANCE = 10;
/** Widest the header gets, pt (on a wide page it stays a quiet line at the left). */
export const HEADER_MAX_WIDTH = 560;
/** The header is looked for in the top part of the page only, pt from the top (and at most this share of the page). */
export const HEADER_SEARCH_DEPTH = 220;
export const HEADER_SEARCH_SHARE = 0.3;
const SEARCH_STEP = 8;

// --- which class ---

/**
 * The class for the header: the one in progress (or about to start, `leadMinutes`) that belongs to the notebook; with
 * `nearest`, failing that the class of today closest in time (the one that just ended or the next one). Overlapping classes: the
 * one that started last wins (as for lecture mode). Time is the device's local wall-clock time, so a class at 09:00 is at
 * 09:00 wherever the device is. Null when there is no class at all.
 */
export function pickHeaderClass(tt: Timetable, path: string | null | undefined, now: Date, leadMinutes: number, nearest: boolean): ClassEntry | null {
	if (!tt.entries.length) return null;
	const current = classForNotebook(classesAt(tt, now, leadMinutes), path, tt.entries);
	if (current || !nearest) return current;
	const minutes = now.getHours() * 60 + now.getMinutes();
	const distance = (e: ClassEntry): number => {
		const s = parseTime(e.start) ?? 0;
		const f = parseTime(e.end) ?? 0;
		return minutes < s ? s - minutes : minutes - f;
	};
	const today = classesOn(tt, now).sort((a, b) => distance(a) - distance(b));
	return classForNotebook(today, path, tt.entries);
}

// --- text ---

const localeOf = (locale: string): string => (locale === "en" ? "en-GB" : locale);

function dateFormat(locale: string, date: Date): string {
	try {
		return new Intl.DateTimeFormat(localeOf(locale), { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
	} catch {
		return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
	}
}

/** `09:00` of the class as the locale writes a time (`9:00 am` in English, `09:00` in Italian). */
function timeFormat(locale: string, hhmm: string, on: Date): string {
	const m = parseTime(hhmm);
	if (m === null) return hhmm;
	const at = new Date(on.getFullYear(), on.getMonth(), on.getDate(), Math.floor(m / 60), m % 60);
	try {
		return new Intl.DateTimeFormat(localeOf(locale), { hour: "2-digit", minute: "2-digit" }).format(at);
	} catch {
		return hhmm;
	}
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export interface HeaderText {
	/** The course. */
	title: string;
	/** `Prof. Rossi · Room B2 · Sunday 8 November 2026 · 09:00`; empty when no other field is on or known. */
	details: string;
}

/** The lines of the header for `cls`, in the language of `locale` (`en` / `it`); an empty field is left out. */
export function headerText(cls: Pick<LectureClass, "course" | "lecturer" | "room" | "start" | "end">, now: Date, locale: string, fields: HeaderFields, roomLabel: string): HeaderText {
	const parts: string[] = [];
	if (fields.lecturer && cls.lecturer) parts.push(oneLine(cls.lecturer));
	if (fields.room && cls.room) parts.push(`${roomLabel} ${oneLine(cls.room)}`);
	if (fields.date) parts.push(dateFormat(locale, now));
	if (fields.time && cls.start) parts.push(timeFormat(locale, cls.start, now));
	return { title: oneLine(cls.course), details: parts.join(" · ") };
}

// --- free area ---

const touches = (a: BBox, b: BBox, clearance: number): boolean =>
	a.minX < b.maxX + clearance && b.minX < a.maxX + clearance && a.minY < b.maxY + clearance && b.minY < a.maxY + clearance;

/** Boxes of everything on the page that a header must not cover: ink and elements. */
export function occupiedBoxes(page: Pick<Page, "strokes" | "elements">, measure: MeasureText = estimateMeasure): BBox[] {
	const out: BBox[] = [];
	for (const s of page.strokes) if (s.points.length) out.push(strokeBounds(s));
	for (const e of page.elements ?? []) out.push(elementBounds(e, measure));
	return out;
}

/**
 * The highest free spot for a box of `width` x `height` in the top of the page: from the top margin down, in small steps, the first
 * place where it keeps `clearance` from everything in `occupied` and stays inside the page. Null when there is none.
 */
export function findFreeSpot(
	page: { width: number; height: number }, occupied: readonly BBox[], width: number, height: number,
	opts: { edge?: number; clearance?: number; depth?: number } = {},
): { x: number; y: number } | null {
	const edge = opts.edge ?? HEADER_EDGE;
	const clearance = opts.clearance ?? HEADER_CLEARANCE;
	const depth = Math.min(opts.depth ?? HEADER_SEARCH_DEPTH, page.height * HEADER_SEARCH_SHARE);
	if (width <= 0 || height <= 0 || width + 2 * edge > page.width + 0.001) return null;
	for (let y = edge; y <= depth && y + height + edge <= page.height; y += SEARCH_STEP) {
		const box: BBox = { minX: edge, minY: y, maxX: edge + width, maxY: y + height };
		if (!occupied.some((o) => touches(box, o, clearance))) return { x: edge, y };
	}
	return null;
}

// --- the plan ---

export type HeaderPlan =
	| { kind: "add"; elements: TextElement[]; group: string | null }
	| { kind: "skip"; reason: "present" | "no-space" | "empty" };

/** The page already has this lecture's header (the one this feature writes, or the title of a "New lecture" page). */
export function pageHasHeader(page: Pick<Page, "elements">, text: HeaderText, course: string, now: Date): boolean {
	const titles = new Set([text.title, lectureHeaderText(course, now)]);
	return (page.elements ?? []).some((e) => e.type === "text" && titles.has(e.text) && (e.group !== undefined || e.text === lectureHeaderText(course, now)));
}

/**
 * What to add to `page`: a title box (the course) and, under it, a details box (lecturer, room, date, time), in one fresh group
 * placed at the highest free spot at the top. Skips when the page already has this header, when there is nothing to write, or
 * when no free spot exists (the view then offers the chip "Add lecture header"). A header with only the course is one box.
 */
export function planLectureHeader(
	page: Pick<Page, "width" | "height" | "strokes" | "elements">, text: HeaderText, course: string, now: Date, measure: MeasureText = estimateMeasure,
): HeaderPlan {
	if (!text.title) return { kind: "skip", reason: "empty" };
	if (pageHasHeader(page, text, course, now)) return { kind: "skip", reason: "present" };
	const width = Math.max(80, Math.min(HEADER_MAX_WIDTH, page.width - 2 * HEADER_EDGE));
	const lay = (s: string, size: number) => layoutText(s, size, width, (x) => measure(x, size)).height;
	const titleHeight = lay(text.title, HEADER_TITLE_SIZE);
	const detailsHeight = text.details ? lay(text.details, HEADER_DETAILS_SIZE) : 0;
	const height = titleHeight + (text.details ? HEADER_GAP + detailsHeight : 0);
	const spot = findFreeSpot(page, occupiedBoxes(page, measure), width, height);
	if (!spot) return { kind: "skip", reason: "no-space" };
	const group = text.details ? createId() : null;
	const round = (v: number) => Math.round(v * 100) / 100;
	const title: TextElement = {
		id: createId(), type: "text", x: spot.x, y: round(spot.y), width, text: text.title, fontSize: HEADER_TITLE_SIZE, color: HEADER_TITLE_COLOR,
	};
	const elements: TextElement[] = [title];
	if (group) {
		title.group = group;
		elements.push({
			id: createId(), type: "text", x: spot.x, y: round(spot.y + titleHeight + HEADER_GAP), width, text: text.details, fontSize: HEADER_DETAILS_SIZE,
			color: HEADER_DETAILS_COLOR, group,
		});
	}
	return { kind: "add", elements: elements.map((e) => freezeElement(e)), group };
}

