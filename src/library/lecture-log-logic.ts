/**
 * Pure logic of the lecture log (0.19, roadmap #221; no DOM, no 'obsidian'): the facts about a lecture session taken from a
 * notebook's pages, the one line written for it in the daily note, and how that line is added or rewritten in the note's
 * text. The line carries a block id (`^nb-lec-<hash>`) of the notebook and the class occurrence, so a session that goes on
 * later rewrites the very same line, and nothing else in the note is ever touched.
 */
import { isMarker } from "../model/markers";
import type { Page } from "../model/types";
import { findLecturePage } from "../timetable/lecture-open";

export const LECTURE_LOG_HEADING_DEFAULT = "## Lectures";
const HEADING_MAX = 80;

/** The heading as the setting holds it: one line, `#`s in front (`## ` added when missing), the default when empty. */
export function normaliseLogHeading(raw: unknown): string {
	const one = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, HEADING_MAX).trim() : "";
	if (one === "" || /^#+$/.test(one)) return LECTURE_LOG_HEADING_DEFAULT;
	return /^#{1,6}\s+\S/.test(one) ? one : `## ${one.replace(/^#+\s*/, "")}`;
}

/** FNV-1a (32 bit) of `text`, base 36: a short, stable id part. */
function hash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36).padStart(7, "0");
}

/** Block id (without the `^`) of the line of one class occurrence in one notebook. `classKey` already names the day. */
export function lectureLogId(notebookPath: string, classKey: string): string {
	return `nb-lec-${hash(`${notebookPath}\n${classKey}`)}`;
}

// ------------------------------------------------------------------------ the facts

/** What a lecture session left in the notebook: its pages and the questions still open. */
export interface LectureSnapshot {
	/** 1-based first and last page of the lecture. */
	first: number;
	last: number;
	/** Id of the first page (for a link that survives reordering). */
	firstId: string;
	pages: number;
	openQuestions: number;
}

/** Does `page` start a lecture or a dated page of its own (a text box whose first line ends with an ISO date)? */
function hasDatedHeader(page: Page): boolean {
	return (page.elements ?? []).some((e) => e.type === "text" && /(^|\s—\s)\d{4}-\d{2}-\d{2}$/.test((e.text.split(/\r?\n/)[0] ?? "").trim()));
}

/**
 * The pages of the lecture of `course` on `date`: from its lecture page (found by header) up to the page before the next one
 * with a dated header. Null when the notebook has no such page. Open questions are the unresolved question markers there.
 */
export function lectureSnapshot(pages: readonly Page[], course: string, date: Date): LectureSnapshot | null {
	const from = findLecturePage(pages, course, date);
	const head = pages[from];
	if (from < 0 || !head) return null;
	let to = from;
	while (to + 1 < pages.length && !hasDatedHeader(pages[to + 1] as Page)) to++;
	let open = 0;
	for (let i = from; i <= to; i++) {
		for (const e of pages[i]?.elements ?? []) if (isMarker(e) && e.kind === "question" && e.done !== true) open++;
	}
	return { first: from + 1, last: to + 1, firstId: head.id, pages: to - from + 1, openQuestions: open };
}

// ------------------------------------------------------------------------ the line

export interface LectureLineParts {
	start: string;
	end: string;
	course: string;
	/** The finished link to the first page (with its alias). */
	link: string;
	/** The counts, already worded ("3 pages", "2 open questions"). */
	counts: string[];
}

/** A course as one line that cannot break the Markdown around it. */
function safeCourse(course: string): string {
	return course.replace(/\s+/g, " ").replace(/[*_`^[\]|]/g, "").trim();
}

/** `- 10:15–11:45 **Analysis I** — [[…|pp. 12–15]] · 3 pages · 2 open questions ^nb-lec-…` */
export function buildLectureLine(p: LectureLineParts, id: string): string {
	const tail = p.counts.filter((c) => c !== "").map((c) => ` · ${c}`).join("");
	return `- ${p.start}–${p.end} **${safeCourse(p.course)}** — ${p.link}${tail} ^${id}`;
}

/** Is `line` the line that carries block id `id` (the id is its last token)? */
function carries(line: string, id: string): boolean {
	const t = line.trimEnd();
	return t.endsWith(`^${id}`) && (t.length === id.length + 1 || /\s/.test(t.charAt(t.length - id.length - 2)));
}

// ------------------------------------------------------------------------ the note

interface Seg {
	text: string;
	eol: string;
}

function segments(text: string): Seg[] {
	const out: Seg[] = [];
	const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m[0] === "") break;
		out.push({ text: m[1] ?? "", eol: m[2] ?? "" });
		if (m[2] === "") break;
	}
	return out;
}

const join = (segs: readonly Seg[]): string => segs.map((s) => s.text + s.eol).join("");

function level(line: string): number {
	const m = /^(#{1,6})\s/.exec(line.trim());
	return m?.[1]?.length ?? 0;
}

/**
 * The note's text with `line` in it, or null when the note already has exactly that line (nothing to write). A line that
 * carries `id` is replaced where it stands (only that line changes, every other byte stays). Otherwise the line is added at
 * the end of the `heading` section (after its last non-blank line, before the next heading of the same or a higher level);
 * a note without the heading gets it at the end, after a blank line.
 */
export function mergeLectureLine(text: string, heading: string, line: string, id: string): string | null {
	const segs = segments(text);
	const own = segs.findIndex((s) => carries(s.text, id));
	if (own >= 0) {
		const seg = segs[own] as Seg;
		if (seg.text.trim() === line.trim()) return null;
		const lead = /^\s*/.exec(seg.text)?.[0] ?? "";
		segs[own] = { text: lead + line.trimStart(), eol: seg.eol };
		return join(segs);
	}
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const want = heading.trim().toLowerCase();
	let fence = false;
	let at = -1;
	for (let i = 0; i < segs.length; i++) {
		const s = (segs[i] as Seg).text;
		if (/^\s*(```|~~~)/.test(s)) fence = !fence;
		if (!fence && level(s) > 0 && s.trim().toLowerCase() === want) {
			at = i;
			break;
		}
	}
	if (at < 0) {
		const needsEol = text !== "" && !/[\r\n]$/.test(text);
		const gap = text === "" ? "" : `${needsEol ? eol : ""}${eol}`;
		return `${text}${gap}${heading}${eol}${line}${eol}`;
	}
	const lvl = level((segs[at] as Seg).text);
	let end = segs.length;
	fence = false;
	for (let i = at + 1; i < segs.length; i++) {
		const s = (segs[i] as Seg).text;
		if (/^\s*(```|~~~)/.test(s)) fence = !fence;
		if (!fence && level(s) > 0 && level(s) <= lvl) {
			end = i;
			break;
		}
	}
	let last = at;
	for (let i = at + 1; i < end; i++) if ((segs[i] as Seg).text.trim() !== "") last = i;
	const prev = segs[last] as Seg;
	const added: Seg = { text: line, eol: prev.eol };
	prev.eol = prev.eol || eol;
	segs.splice(last + 1, 0, added);
	return join(segs);
}

// ------------------------------------------------------------------------ lines waiting for their note

/** A line that could not be written yet: the daily note is missing and may not be made. Kept on this device only. */
export interface PendingLectureLine {
	id: string;
	/** Local day of the class, `YYYY-MM-DD`. */
	day: string;
	notePath: string;
	line: string;
}

export const LECTURE_LOG_PENDING_KEY = "notebook-lecture-log-pending";
export const LECTURE_LOG_PENDING_MAX = 30;
/** Days a waiting line is kept. */
export const LECTURE_LOG_PENDING_DAYS = 21;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whatever was stored, as a valid, bounded list: bad rows dropped, old days dropped, the newest kept. */
export function normalisePending(data: unknown, today: string): PendingLectureLine[] {
	if (!Array.isArray(data) || !DAY.test(today)) return [];
	const [y, m, d] = today.split("-").map(Number) as [number, number, number];
	const t = new Date(y, m - 1, d - LECTURE_LOG_PENDING_DAYS);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const oldest = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
	const out: PendingLectureLine[] = [];
	for (const row of data) {
		if (typeof row !== "object" || row === null) continue;
		const r = row as Record<string, unknown>;
		if (typeof r.id !== "string" || !/^nb-lec-[0-9a-z]+$/.test(r.id) || typeof r.day !== "string" || !DAY.test(r.day) || r.day < oldest) continue;
		if (typeof r.notePath !== "string" || r.notePath === "" || r.notePath.length > 400 || typeof r.line !== "string" || r.line.length > 1000 || r.line.includes("\n")) continue;
		if (!carries(r.line, r.id)) continue;
		const at = out.findIndex((p) => p.id === r.id);
		if (at >= 0) out.splice(at, 1);
		out.push({ id: r.id, day: r.day, notePath: r.notePath, line: r.line });
	}
	return out.slice(-LECTURE_LOG_PENDING_MAX);
}

/** The list with `entry` added (replacing the one with the same id, which becomes the newest). */
export function addPending(list: readonly PendingLectureLine[], entry: PendingLectureLine, today: string): PendingLectureLine[] {
	return normalisePending([...list.filter((p) => p.id !== entry.id), entry], today);
}

export function removePending(list: readonly PendingLectureLine[], id: string): PendingLectureLine[] {
	return list.filter((p) => p.id !== id);
}
