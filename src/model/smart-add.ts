/**
 * Roadmap 410, Smart "+": which new pages to offer in one tap. Pure and deterministic (no clock, no random, no
 * `obsidian`): the same page, history and context always give the same list, so it can be tested in Node.
 *
 * Candidates: "same" (the paper of the page in view), "exercise" (the exercise paper, in a lecture context),
 * "slide" (a notes page for the slide in view of the side-by-side PDF), "recent-paper" (the paper this notebook's
 * added pages used most recently, e.g. Cornell) and "blank". Two candidates that would make the same page are
 * merged (the higher score stays), and "same" is never left out.
 */
import { PAPER_KINDS, type PaperKind } from "./types";

export const SMART_ADD_IDS = ["same", "exercise", "slide", "recent-paper", "blank"] as const;
export type SmartAddId = (typeof SMART_ADD_IDS)[number];

/** What was added before in this notebook, newest first. */
export interface SmartAddHistoryEntry {
	id: SmartAddId;
	paper?: PaperKind;
}

export interface SmartAddInput {
	/** Paper of the page in view. */
	paper: PaperKind;
	/** The page in view is a PDF page or a scan (a lecture or reading context). */
	hasBackground: boolean;
	/** 1-based slide in view of the side-by-side PDF, or null when no PDF is beside the notes. */
	slide: number | null;
	/** Paper of "Exercise page here". */
	exercisePaper: PaperKind;
	history: readonly SmartAddHistoryEntry[];
	/** Papers of the other pages of the notebook, nearest to the page in view first (a notebook of Cornell pages offers Cornell). */
	nearbyPapers?: readonly PaperKind[];
}

export interface SmartAddChoice {
	id: SmartAddId;
	/** The paper of the page that will be made (not for "slide": the page follows the one in view). */
	paper?: PaperKind;
	score: number;
}

export const SMART_ADD_LIMIT = 3;
export const SMART_ADD_HISTORY_MAX = 12;
/** How many of the latest additions count for the habit bonus. */
const RECENT = 6;

function count(history: readonly SmartAddHistoryEntry[], id: SmartAddId): number {
	return history.slice(0, RECENT).filter((h) => h.id === id).length;
}

/** The ranked candidates, best first, at most `limit` (default 3). Never empty: "same" is always there. */
export function rankSmartAdd(input: SmartAddInput, limit: number = SMART_ADD_LIMIT): SmartAddChoice[] {
	const { paper, history } = input;
	const lecture = input.hasBackground || input.slide !== null;
	const all: SmartAddChoice[] = [];

	all.push({ id: "same", paper, score: 60 + (history[0]?.id === "same" ? 15 : 0) + count(history, "same") * 2 });
	if (input.slide !== null) all.push({ id: "slide", score: 100 });
	all.push({ id: "exercise", paper: input.exercisePaper, score: 40 + (lecture ? 35 : 0) + count(history, "exercise") * 8 });

	// The latest paper (other than this page's) that an addition used; its habit grows the score.
	const lastOther = history.find((h) => h.paper && h.paper !== paper && h.id !== "exercise")?.paper;
	if (lastOther) {
		const uses = history.slice(0, RECENT).filter((h) => h.paper === lastOther && h.id !== "exercise").length;
		all.push({ id: "recent-paper", paper: lastOther, score: 50 + uses * 6 });
	} else {
		const near = input.nearbyPapers?.find((p) => p !== paper);
		if (near) all.push({ id: "recent-paper", paper: near, score: 45 });
	}
	if (paper !== "blank") all.push({ id: "blank", paper: "blank", score: 20 + count(history, "blank") * 8 });

	// One candidate per resulting page: the same paper twice is one choice (the slide page is its own kind).
	const best = new Map<string, SmartAddChoice>();
	for (const c of all) {
		const key = c.id === "slide" ? "slide" : (c.paper ?? "");
		const have = best.get(key);
		if (!have || c.score > have.score || (c.score === have.score && order(c.id) < order(have.id))) best.set(key, c);
	}
	const ranked = [...best.values()].sort((a, b) => b.score - a.score || order(a.id) - order(b.id));
	const top = ranked.slice(0, Math.max(1, limit));
	if (!top.some((c) => c.id === "same" || (c.paper === paper && c.id !== "slide"))) {
		const same = ranked.find((c) => c.id === "same") ?? all[0]!;
		top[top.length - 1] = same;
	}
	return top;
}

function order(id: SmartAddId): number {
	return SMART_ADD_IDS.indexOf(id);
}

/** Puts a taken choice at the front of the history (bounded). */
export function pushSmartAdd(history: readonly SmartAddHistoryEntry[], entry: SmartAddHistoryEntry): SmartAddHistoryEntry[] {
	const e: SmartAddHistoryEntry = entry.paper ? { id: entry.id, paper: entry.paper } : { id: entry.id };
	return [e, ...history].slice(0, SMART_ADD_HISTORY_MAX);
}

/** Reads a stored history; anything that is not a valid entry is dropped, never thrown. */
export function parseSmartAddHistory(raw: unknown): SmartAddHistoryEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: SmartAddHistoryEntry[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const { id, paper } = item as { id?: unknown; paper?: unknown };
		if (typeof id !== "string" || !(SMART_ADD_IDS as readonly string[]).includes(id)) continue;
		const entry: SmartAddHistoryEntry = { id: id as SmartAddId };
		if (typeof paper === "string" && (PAPER_KINDS as readonly string[]).includes(paper)) entry.paper = paper as PaperKind;
		out.push(entry);
		if (out.length >= SMART_ADD_HISTORY_MAX) break;
	}
	return out;
}

/** The papers of the pages around `index` (before it nearest first, then after it), without repeats; at most 8. */
export function nearbyPapers(pages: ReadonlyArray<{ paper: { kind: PaperKind } }>, index: number): PaperKind[] {
	const out: PaperKind[] = [];
	for (let d = 1; d < pages.length && out.length < 8; d++) {
		for (const i of [index - d, index + d]) {
			const kind = pages[i]?.paper.kind;
			if (kind && !out.includes(kind)) out.push(kind);
		}
	}
	return out;
}
