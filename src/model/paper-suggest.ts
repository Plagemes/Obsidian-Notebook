/**
 * Roadmap 409, suggested paper for a new page. Pure and deterministic (no clock, no random, no `obsidian`): from the papers of
 * the pages already written (the last few before the new one), the papers this device added for the course of the class in
 * progress, and any candidates another feature supplies (a profile's default paper), it returns a list of candidates with a
 * score and a structured reason. The view shows the best one as the highlighted choice of the "+" strip with the reason in
 * words; nothing is ever forced and nothing is written into a notebook.
 *
 * The API is a plain list on purpose: `extra` takes candidates with their own score (a profile paper uses `PROFILE_SCORE`,
 * which outranks every history signal), and the result is a sorted list of the same shape.
 */
import { PAPER_KINDS, type PaperKind } from "./types";

export type PaperReasonKind = "profile" | "pattern" | "recent" | "recentMost" | "course" | "notebook" | "current";

export interface PaperReason {
	kind: PaperReasonKind;
	/** "recent" / "recentMost" / "pattern": how many of the latest pages were looked at. */
	n?: number;
	/** "course": the course name. */
	course?: string;
}

export interface PaperCandidate {
	paper: PaperKind;
	score: number;
	reason: PaperReason;
}

/** Score of a paper chosen by the user for a profile: above anything history can reach. */
export const PROFILE_SCORE = 200;
/** A suggestion below this score is not worth highlighting. */
export const SUGGEST_MIN_SCORE = 35;
/** How many of the latest pages (the page in view included) count as "the last pages". */
export const SUGGEST_WINDOW = 6;

export type CourseUsage = Readonly<Partial<Record<PaperKind, number>>>;

export interface PaperSuggestInput {
	/** Papers of the notebook's pages in page order. */
	pages: readonly PaperKind[];
	/** Index of the page the new one follows. */
	index: number;
	/** The course of the class in progress for this notebook, with how often each paper was added for it on this device. */
	course?: { name: string; usage: CourseUsage } | null;
	/** Candidates from elsewhere (a profile's default paper), merged with the history ones. */
	extra?: readonly PaperCandidate[];
}

function isPaper(x: unknown): x is PaperKind {
	return typeof x === "string" && (PAPER_KINDS as readonly string[]).includes(x);
}

/** All candidates, best first (ties: the paper of the page in view first, then the order of `PAPER_KINDS`). Never empty. */
export function paperCandidates(input: PaperSuggestInput): PaperCandidate[] {
	const { pages } = input;
	const at = Math.min(Math.max(input.index, 0), Math.max(pages.length - 1, 0));
	const current: PaperKind = pages[at] ?? "blank";
	const w = pages.slice(Math.max(0, at - SUGGEST_WINDOW + 1), at + 1);
	const best = new Map<PaperKind, PaperCandidate>();
	const put = (paper: PaperKind, score: number, reason: PaperReason): void => {
		const have = best.get(paper);
		if (!have) best.set(paper, { paper, score, reason });
		else if (score > have.score) best.set(paper, { paper, score: score + 3, reason });
		else best.set(paper, { ...have, score: have.score + 3 });
	};

	put(current, 10, { kind: "current" });

	// Two papers taking turns (A B A B): the next one is the paper of two pages back.
	if (w.length >= 4) {
		const [a, b, c, d] = w.slice(-4);
		if (a && a === c && b === d && a !== b) put(a, 90, { kind: "pattern", n: w.length });
	}

	// The same paper for the last pages, or for most of them.
	if (w.length >= 3) {
		let run = 0;
		for (let i = w.length - 1; i >= 0 && w[i] === current; i--) run++;
		if (run >= 3) put(current, 70 + Math.min(run, 6) * 2, { kind: "recent", n: run });
		const counts = new Map<PaperKind, number>();
		for (const p of w) counts.set(p, (counts.get(p) ?? 0) + 1);
		for (const [paper, c] of counts) {
			if (c < Math.ceil(w.length * 0.6) || (paper === current && run >= 3)) continue;
			put(paper, 40 + c * 5, c === w.length ? { kind: "recent", n: w.length } : { kind: "recentMost", n: w.length });
		}
	}

	// What was added for this course before.
	const course = input.course;
	if (course?.name) {
		let total = 0;
		for (const k of PAPER_KINDS) total += course.usage[k] ?? 0;
		if (total >= 3) {
			for (const k of PAPER_KINDS) {
				const share = (course.usage[k] ?? 0) / total;
				if (share >= 0.5) put(k, 55 + Math.round(share * 20), { kind: "course", course: course.name });
			}
		}
	}

	// The whole notebook, when it is clearly one paper.
	if (pages.length >= 4) {
		const counts = new Map<PaperKind, number>();
		for (const p of pages) counts.set(p, (counts.get(p) ?? 0) + 1);
		for (const [paper, c] of counts) if (c >= Math.ceil(pages.length * 0.6)) put(paper, 35, { kind: "notebook" });
	}

	for (const e of input.extra ?? []) if (isPaper(e.paper) && Number.isFinite(e.score)) put(e.paper, e.score, e.reason);

	const rank = (p: PaperKind): number => (p === current ? -1 : PAPER_KINDS.indexOf(p));
	return [...best.values()].sort((x, y) => y.score - x.score || rank(x.paper) - rank(y.paper));
}

/** The one worth highlighting: the best candidate with a real reason and a score of at least `SUGGEST_MIN_SCORE`; else null. */
export function suggestPaper(input: PaperSuggestInput): PaperCandidate | null {
	const top = paperCandidates(input).find((c) => c.reason.kind !== "current");
	return top && top.score >= SUGGEST_MIN_SCORE ? top : null;
}

// ------------------------------------------------------------------------------------------------------ the strip

/** The part of a strip choice this module needs (the strip's own choice type satisfies it). */
export interface StripChoiceLike {
	id: string;
	paper?: PaperKind;
}

export interface SuggestedStrip<C extends StripChoiceLike> {
	choices: C[];
	/** Index in `choices` of the highlighted one, or -1 when nothing is suggested. */
	highlight: number;
}

/**
 * Puts the suggestion into the strip's choices without forcing it: the choice that already makes that paper is highlighted
 * (and moved up front, unless the slide choice leads); when there is none, `make` builds one and it replaces the weakest
 * non-"same" choice (or is added when there is room). The "same" choice and the slide choice are never dropped.
 */
export function applyPaperSuggestion<C extends StripChoiceLike>(
	choices: readonly C[], suggestion: PaperCandidate | null, currentPaper: PaperKind, limit: number, make: (paper: PaperKind) => C,
): SuggestedStrip<C> {
	if (!suggestion) return { choices: [...choices], highlight: -1 };
	const makes = (c: C): boolean => c.id !== "slide" && (c.paper ?? (c.id === "same" ? currentPaper : undefined)) === suggestion.paper;
	let list = [...choices];
	let target = list.find(makes);
	if (!target) {
		const made = make(suggestion.paper);
		if (list.length < limit) list.push(made);
		else {
			let drop = -1;
			for (let i = list.length - 1; i >= 0; i--) {
				if (list[i]!.id !== "same" && list[i]!.id !== "slide") {
					drop = i;
					break;
				}
			}
			if (drop < 0) return { choices: list, highlight: -1 };
			list[drop] = made;
		}
		target = made;
	}
	const lead = list[0]?.id === "slide" ? 1 : 0;
	const chosen = target;
	list = list.filter((c) => c !== chosen);
	list.splice(lead, 0, chosen);
	return { choices: list, highlight: lead };
}

// ------------------------------------------------------------------------------------------ course habit (per device)

/** Local storage key of the course habit (one value for the device). */
export const COURSE_PAPER_KEY = "notebook-course-paper";
export const COURSE_PAPER_MAX_COURSES = 40;
/** When a course's counts add up to more than this they are halved, so a changed habit wins in a few pages. */
export const COURSE_PAPER_DECAY_AT = 40;
const COURSE_NAME_MAX = 80;

interface CourseRow {
	at: number;
	name: string;
	usage: CourseUsage;
}

/** What the device keeps: for each course (lower-case key), when it last changed and how often each paper was added. */
export type CoursePaperStore = Readonly<Record<string, CourseRow>>;

function courseKey(name: string): string {
	return name.trim().toLowerCase().slice(0, COURSE_NAME_MAX);
}

/** Whatever was stored, as a valid, bounded store: bad rows are dropped, the least recent courses are forgotten. */
export function normaliseCoursePaperStore(data: unknown): CoursePaperStore {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
	const rows: Array<[string, CourseRow]> = [];
	for (const [key, v] of Object.entries(data as Record<string, unknown>)) {
		if (!key || key.length > COURSE_NAME_MAX || typeof v !== "object" || v === null) continue;
		const { at, name, usage } = v as { at?: unknown; name?: unknown; usage?: unknown };
		if (typeof name !== "string" || typeof usage !== "object" || usage === null) continue;
		const clean: Partial<Record<PaperKind, number>> = {};
		for (const [k, n] of Object.entries(usage as Record<string, unknown>)) {
			if (isPaper(k) && typeof n === "number" && Number.isFinite(n) && n > 0) clean[k] = Math.min(Math.floor(n), 1000);
		}
		if (Object.keys(clean).length === 0) continue;
		rows.push([key, { at: typeof at === "number" && Number.isFinite(at) ? at : 0, name: name.slice(0, COURSE_NAME_MAX), usage: clean }]);
	}
	rows.sort((a, b) => b[1].at - a[1].at);
	return Object.fromEntries(rows.slice(0, COURSE_PAPER_MAX_COURSES));
}

/** The store after a page with `paper` was added for `course` (a new object). */
export function rememberCoursePaper(store: CoursePaperStore, course: string, paper: PaperKind, now: number): CoursePaperStore {
	const key = courseKey(course);
	if (!key || !isPaper(paper)) return store;
	const have = store[key]?.usage ?? {};
	let usage: Partial<Record<PaperKind, number>> = { ...have, [paper]: (have[paper] ?? 0) + 1 };
	let total = 0;
	for (const k of PAPER_KINDS) total += usage[k] ?? 0;
	if (total > COURSE_PAPER_DECAY_AT) {
		const half: Partial<Record<PaperKind, number>> = {};
		for (const k of PAPER_KINDS) if ((usage[k] ?? 0) > 1) half[k] = Math.floor((usage[k] ?? 0) / 2);
		half[paper] = Math.max(half[paper] ?? 0, 1);
		usage = half;
	}
	return normaliseCoursePaperStore({ ...store, [key]: { at: now, name: course.trim().slice(0, COURSE_NAME_MAX), usage } });
}

/** How often each paper was added for this course; empty when unknown. */
export function courseUsageOf(store: CoursePaperStore, course: string): CourseUsage {
	return store[courseKey(course)]?.usage ?? {};
}
