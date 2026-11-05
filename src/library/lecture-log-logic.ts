/**
 * Pure logic of the lecture log (0.19, roadmap #221; no DOM, no 'obsidian'): the facts about a lecture session taken from a
 * notebook's pages, the one line written for it in the daily note, and how that line is added or rewritten in the note's
 * text. The line carries a block id (`^nb-lec-<hash>`) of the notebook and the class occurrence, so a session that goes on
 * later rewrites the very same line, and nothing else in the note is ever touched.
 */
import { escapeSearchText } from "../model/companion-search";
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

/**
 * Block id (without the `^`) of the line of one class occurrence in one notebook. `notebookKey` is the notebook's document id
 * (it survives a rename or a move; the path only when there is no id); `classKey` already names the day.
 */
export function lectureLogId(notebookKey: string, classKey: string): string {
	return `nb-lec-${hash(`${notebookKey}\n${classKey}`)}`;
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

/**
 * A course as one line of plain text that cannot break the Markdown around it: emphasis, code, link and block characters are
 * dropped, the rest (comments `%%`, `<!--`, tags, math, highlights, a trailing backslash…) is escaped.
 */
function safeCourse(course: string): string {
	return escapeSearchText(course.replace(/\s+/g, " ").replace(/[*_`^[\]|]/g, "").trim());
}

/**
 * `- 10:15–11:45 **Analysis I** · 3 pages · 2 open questions — [[…|pp. 12–15]] ^nb-lec-…`
 * The part the plugin generates ends with the link: whatever follows it up to the block id is the user's own and is kept.
 */
export function buildLectureLine(p: LectureLineParts, id: string): string {
	const counts = p.counts.filter((c) => c !== "").map((c) => ` · ${c}`).join("");
	return `- ${p.start}–${p.end} **${safeCourse(p.course)}**${counts} — ${p.link} ^${id}`;
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

/** For each line: is it inside a fenced code block (the fence lines themselves count as inside)? */
function fenced(segs: readonly Seg[]): boolean[] {
	let fence = false;
	return segs.map((s) => {
		const edge = /^\s*(```|~~~)/.test(s.text);
		const inside = fence || edge;
		if (edge) fence = !fence;
		return inside;
	});
}

/** The end of the link that starts at `from` (`[[…]]` or `[alias](url)`), or -1. */
function linkEnd(s: string, from: number): number {
	if (s.startsWith("[[", from)) {
		const j = s.indexOf("]]", from + 2);
		return j < 0 ? -1 : j + 2;
	}
	if (s.charAt(from) !== "[") return -1;
	const close = s.indexOf("]", from + 1);
	if (close < 0 || s.charAt(close + 1) !== "(") return -1;
	let depth = 0;
	for (let k = close + 1; k < s.length; k++) {
		const c = s.charAt(k);
		if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return k + 1;
	}
	return -1;
}

/** The leading part a user may add to a list line: quote marks and indentation, a list marker, a task box. */
const PREFIX = /^(?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(?:\[[^\]\r\n]\][ \t]+)?/;
/** `10:15–11:45 **Course**` */
const HEAD = /^\d{1,2}:\d{2}–\d{1,2}:\d{2} \*\*[^*\r\n]*\*\*/;

/**
 * Splits a log line into what the user may have put in front of it (`prefix`) and what the plugin generated (`generated`: the
 * time range, the course, the counts and the link). Null when the line no longer has that shape. What follows the generated
 * part (the user's own words, the block id) is the rest of the line.
 */
function splitOwn(text: string): { prefix: string; generated: string } | null {
	const prefix = PREFIX.exec(text)?.[0] ?? "";
	const rest = text.slice(prefix.length);
	const head = HEAD.exec(rest);
	if (!head) return null;
	const dash = rest.indexOf(" — ", head[0].length);
	if (dash < 0) return null;
	const end = linkEnd(rest, dash + 3);
	if (end < 0) return null;
	return { prefix, generated: rest.slice(0, end) };
}

/** "none": no line of ours in the text (outside code fences); "ours": it has the generated shape; "altered": it carries the id but the user changed it into something else. */
export function ownLineState(text: string, id: string): "none" | "ours" | "altered" {
	const segs = segments(text);
	const inFence = fenced(segs);
	const at = segs.findIndex((s, i) => !inFence[i] && carries(s.text, id));
	if (at < 0) return "none";
	return splitOwn((segs[at] as Seg).text) ? "ours" : "altered";
}

/**
 * The note's text with `line` in it, or null when there is nothing to write (the note already has exactly that line, or the
 * user changed the line so much that it is left alone). A line that carries `id` (outside code fences) is rewritten where it
 * stands, and only its generated part: what the user put in front of it (a quote mark, a list marker, a task box) and what they
 * added after the link stays. Otherwise the line is added at the end of the `heading` section (after its last non-blank line,
 * before the next heading of the same or a higher level); a note without the heading gets it at the end, after a blank line.
 */
export function mergeLectureLine(text: string, heading: string, line: string, id: string): string | null {
	const segs = segments(text);
	const inFence = fenced(segs);
	const own = segs.findIndex((s, i) => !inFence[i] && carries(s.text, id));
	if (own >= 0) {
		const seg = segs[own] as Seg;
		const old = splitOwn(seg.text);
		const fresh = splitOwn(line);
		if (!old || !fresh) return null;
		const next = seg.text.slice(0, old.prefix.length) + fresh.generated + seg.text.slice(old.prefix.length + old.generated.length);
		if (next === seg.text) return null;
		segs[own] = { text: next, eol: seg.eol };
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

/**
 * A line that is not settled yet: it could not be written (the daily note is missing and may not be made), or it was written
 * and is waiting to be seen again in the note (a template engine may overwrite a new note a moment later). Kept on this device only.
 */
export interface PendingLectureLine {
	id: string;
	/** Local day of the class, `YYYY-MM-DD`. */
	day: string;
	notePath: string;
	line: string;
	/** When the line was written into the note (ms), if it was: the entry stays until a later read of the note shows the line. */
	wrote?: number;
	/** How many times the line was written again because a read showed it gone. */
	tries?: number;
}

/** Times a vanished line is written again before it is given up. */
export const LECTURE_LOG_MAX_TRIES = 3;

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
		const entry: PendingLectureLine = { id: r.id, day: r.day, notePath: r.notePath, line: r.line };
		if (typeof r.wrote === "number" && Number.isFinite(r.wrote) && r.wrote > 0) entry.wrote = r.wrote;
		if (typeof r.tries === "number" && Number.isInteger(r.tries) && r.tries > 0 && r.tries <= LECTURE_LOG_MAX_TRIES) entry.tries = r.tries;
		out.push(entry);
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
