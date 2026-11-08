/**
 * 0.23 (#420) "Welcome back": when a notebook is reopened after a while, a quiet card offers the way back to where the reader
 * was and the open questions and gaps that are already marked in the notebook. Pure (no DOM, no 'obsidian'); nothing here is new
 * data: the place is `doc.position`, the questions and gaps are the v8 markers, the slide is the page's PDF page. The only thing
 * remembered is when this device last had the notebook open, in the device's local storage (bounded; never in the file).
 */
import { slideNumberOf } from "./slide-back";
import { resolvePosition } from "./position";
import type { MarkerElement, NotebookDocument } from "./types";

/** Local storage key of the per-notebook "last seen" times. */
export const WELCOME_KEY = "notebook-welcome-back-seen";
/** Notebooks remembered (the least recently seen are forgotten first). */
export const WELCOME_MAX_NOTEBOOKS = 80;
export const WELCOME_HOURS_MIN = 1;
export const WELCOME_HOURS_MAX = 168;
export const WELCOME_HOURS_DEFAULT = 8;
/** Most questions and most gaps listed as links. */
export const WELCOME_PER_GROUP = 2;
/** Most characters of a marker's text shown. */
export const WELCOME_TEXT_MAX = 60;

const ID = /^[A-Za-z0-9_.-]{1,80}$/;

/** The hours setting kept in range (anything that is not a finite number gives the default). */
export function clampWelcomeHours(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return WELCOME_HOURS_DEFAULT;
	return Math.min(WELCOME_HOURS_MAX, Math.max(WELCOME_HOURS_MIN, Math.round(value)));
}

export type WelcomeSeen = Readonly<Record<string, number>>;

/** Whatever was stored, as a valid, bounded map: bad ids and times are dropped, the oldest are forgotten. */
export function normaliseSeen(data: unknown): WelcomeSeen {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
	const rows = Object.entries(data as Record<string, unknown>)
		.filter(([id, v]) => ID.test(id) && typeof v === "number" && Number.isFinite(v) && v > 0)
		.map(([id, v]) => [id, v as number] as const)
		.sort((a, b) => b[1] - a[1])
		.slice(0, WELCOME_MAX_NOTEBOOKS);
	return Object.fromEntries(rows);
}

/** The map with notebook `id` seen at `now` (a new object; an invalid id leaves it as it was). */
export function recordSeen(seen: WelcomeSeen, id: string, now: number): WelcomeSeen {
	if (!ID.test(id) || !Number.isFinite(now) || now <= 0) return seen;
	return normaliseSeen({ ...seen, [id]: now });
}

export interface WelcomeItem {
	pageIndex: number;
	pageId: string;
	/** Page y of the marker (pt). */
	y: number;
	/** The marker's own label, shortened; null when it has none. */
	text: string | null;
}

export interface WelcomeResume {
	index: number;
	y: number;
	/** 1-based PDF page of the page, when it shows one. */
	slide: number | null;
}

export interface WelcomePlan {
	awayMs: number;
	resume: WelcomeResume | null;
	questions: WelcomeItem[];
	gaps: WelcomeItem[];
	/** Open ones in all (the lists above hold at most `WELCOME_PER_GROUP`). */
	questionTotal: number;
	gapTotal: number;
}

export interface WelcomeInput {
	/** When this device last had the notebook open (ms), or null when it never did. */
	lastSeen: number | null;
	now: number;
	hours: number;
}

function shorten(text: string | undefined): string | null {
	if (!text) return null;
	const chars = Array.from(text.trim());
	if (chars.length === 0) return null;
	return chars.length > WELCOME_TEXT_MAX ? `${chars.slice(0, WELCOME_TEXT_MAX - 1).join("")}…` : chars.join("");
}

/**
 * What the card offers, or null when there is nothing to show: the notebook was never open on this device, it was open less than
 * `hours` ago, or there is neither a place to go back to nor an open question or gap.
 */
export function planWelcome(doc: NotebookDocument, input: WelcomeInput): WelcomePlan | null {
	if (input.lastSeen === null || !Number.isFinite(input.lastSeen)) return null;
	const awayMs = input.now - input.lastSeen;
	if (!(awayMs >= clampWelcomeHours(input.hours) * 3_600_000)) return null;
	const open: { question: WelcomeItem[]; gap: WelcomeItem[] } = { question: [], gap: [] };
	doc.pages.forEach((page, pageIndex) => {
		const marks = (page.elements ?? []).filter((e): e is MarkerElement => e.type === "marker" && (e.kind === "question" || e.kind === "gap") && e.done !== true);
		marks.sort((a, b) => a.y - b.y || a.x - b.x);
		for (const m of marks) open[m.kind === "question" ? "question" : "gap"].push({ pageIndex, pageId: page.id, y: m.y, text: shorten(m.text) });
	});
	let resume: WelcomeResume | null = null;
	const at = resolvePosition(doc);
	if (at && (at.index > 0 || at.y > 0)) {
		const page = doc.pages[at.index]!;
		resume = { index: at.index, y: at.y, slide: slideNumberOf(doc, page, {}) };
	}
	if (!resume && open.question.length === 0 && open.gap.length === 0) return null;
	return {
		awayMs,
		resume,
		questions: open.question.slice(0, WELCOME_PER_GROUP),
		gaps: open.gap.slice(0, WELCOME_PER_GROUP),
		questionTotal: open.question.length,
		gapTotal: open.gap.length,
	};
}

/** "3 days", "5 hours" in whole units, as the pair for the translation: unit "h" | "d" and the count. */
export function awayParts(awayMs: number): { unit: "h" | "d"; n: number } {
	const hours = Math.max(1, Math.floor(awayMs / 3_600_000));
	return hours >= 48 ? { unit: "d", n: Math.floor(hours / 24) } : { unit: "h", n: hours };
}
