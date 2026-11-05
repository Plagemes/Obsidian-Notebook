/**
 * Notebook map (roadmap #408, extends the end-of-lecture panel #223 from one lecture to the whole notebook): for every page,
 * which states it is in (open question, gap to complete, homework, key point, nearly empty, unfinished practice) and how many
 * of each, so the map can show a grid of pages with badges and filter it. Pure (no 'obsidian', no DOM) and format-neutral:
 * everything is derived from data the document already has, nothing is stored.
 *
 * `NotebookMapCache` keeps one entry per page and recomputes it only when the page's revision key changes; the key reads
 * counts and element fields, never the points of a stroke, so an unchanged page costs a few comparisons.
 */
import { hasPracticeTag } from "./practice";
import { isResolvable, lectureRange, startsLecture } from "./markers";
import type { MarkerElement, Page } from "./types";

/** The states a page can be in. A page can be in several; a page in none is "clear". */
export const MAP_STATES = ["question", "gap", "homework", "practice", "empty", "key", "checklist"] as const;
export type MapState = (typeof MAP_STATES)[number];

/** A page with no more visible strokes than this, and nothing else on it, is nearly empty. */
export const NEARLY_EMPTY_STROKES = 6;

export interface MapPage {
	/** 0-based position and the page id. */
	index: number;
	pageId: string;
	/** In the order of MAP_STATES. */
	states: MapState[];
	/** Open (unresolved) question, gap and homework markers, and importance markers (never resolved). */
	open: { question: number; gap: number; homework: number; key: number; /** v17: checkboxes not ticked. */ checklist: number };
	/** Earliest due date among the open homework markers of the page. */
	due?: string;
	/** The label of the first open question or homework (one line), for the tooltip. */
	hint?: string;
	/** Start of a lecture (the page carries a lecture header): the map marks the lecture boundaries. */
	lectureStart: boolean;
	/** 0.16 (#124): the page is locked. Not a state (a locked page can still be clear); the map only marks it. */
	locked?: true;
}

export interface MapCounts {
	/** Pages in each state. */
	pages: Record<MapState, number>;
	/** Pages in no state at all. */
	clear: number;
	total: number;
}

export interface NotebookMap {
	pages: MapPage[];
	counts: MapCounts;
}

export interface MapOptions {
	/** Ids of practice pages known to be finished (the attempt was timed and stopped). Absent: judged from the ink. */
	practiceDone?: ReadonlySet<string>;
}

/** Whether a page has nothing on it but (at most) a few strokes and markers: no text, picture, equation, graph, box, excerpt or background. */
export function isNearlyEmpty(page: Page): boolean {
	if (page.background) return false;
	let visible = 0;
	for (const s of page.strokes) if (!s.hidden) visible++;
	if (visible > NEARLY_EMPTY_STROKES) return false;
	return !(page.elements ?? []).some((e) => e.type !== "marker");
}

const isKey = (m: MarkerElement): boolean => !isResolvable(m.kind);

/** Computes the entry of one page (no cache). */
export function mapPage(page: Page, index: number, opts: MapOptions = {}): MapPage {
	const open = { question: 0, gap: 0, homework: 0, key: 0, checklist: 0 };
	let due: string | undefined;
	let hint: string | undefined;
	for (const el of page.elements ?? []) {
		// v17: an unticked checkbox is an open item of the page (the "Open items" filter of the map).
		if (el.type === "checkbox") {
			if (el.checked !== true) {
				open.checklist++;
				if (hint === undefined && el.label) hint = el.label;
			}
			continue;
		}
		if (el.type !== "marker") continue;
		if (isKey(el)) {
			open.key++;
			continue;
		}
		if (el.done) continue;
		if (el.kind === "question") open.question++;
		else if (el.kind === "gap") open.gap++;
		else if (el.kind === "homework") {
			open.homework++;
			if (el.due && (due === undefined || el.due < due)) due = el.due;
		}
		if (hint === undefined && el.text && (el.kind === "question" || el.kind === "homework")) hint = el.text;
	}
	const practice = hasPracticeTag(page.tags);
	const nearlyEmpty = isNearlyEmpty(page);
	const has: Record<MapState, boolean> = {
		question: open.question > 0,
		gap: open.gap > 0,
		homework: open.homework > 0,
		// A practice copy is unfinished until its timed attempt is stopped; when the device does not know, until something is written.
		practice: practice && (opts.practiceDone ? !opts.practiceDone.has(page.id) : nearlyEmpty),
		// A practice page waiting for its answer is shown as practice, not as an empty page.
		empty: nearlyEmpty && !practice,
		key: open.key > 0,
		checklist: open.checklist > 0,
	};
	const out: MapPage = {
		index, pageId: page.id, states: MAP_STATES.filter((s) => has[s]), open, lectureStart: startsLecture(page),
	};
	if (due !== undefined) out.due = due;
	if (hint !== undefined) out.hint = hint;
	if (page.locked === true) out.locked = true;
	return out;
}

/** The revision key of a page: changes whenever anything the map reads changes. */
export function mapKey(page: Page, opts: MapOptions = {}): string {
	const parts: Array<string | number> = [page.strokes.length, page.background ? 1 : 0, page.tags?.join(",") ?? "", page.locked ? "L" : ""];
	let hidden = 0;
	for (const s of page.strokes) if (s.hidden) hidden++;
	parts.push(hidden);
	for (const el of page.elements ?? []) {
		if (el.type === "marker") parts.push(el.id, el.kind, el.done ? 1 : 0, el.due ?? "", el.text ?? "");
		else if (el.type === "checkbox") parts.push(el.id, el.checked ? "c1" : "c0", el.label ?? "");
		else if (el.type === "text") parts.push("t", el.text);
		else parts.push(el.type);
	}
	if (opts.practiceDone) parts.push(opts.practiceDone.has(page.id) ? "pd" : "pu");
	return parts.join("|");
}

/** Counts per state over `pages`. */
export function countStates(pages: readonly MapPage[]): MapCounts {
	const counts: MapCounts = { pages: { question: 0, gap: 0, homework: 0, practice: 0, empty: 0, key: 0, checklist: 0 }, clear: 0, total: pages.length };
	for (const p of pages) {
		if (p.states.length === 0) counts.clear++;
		for (const s of p.states) counts.pages[s]++;
	}
	return counts;
}

/** Pages in `state` (null: all of them). */
export function filterByState(pages: readonly MapPage[], state: MapState | null): MapPage[] {
	return state === null ? [...pages] : pages.filter((p) => p.states.includes(state));
}

/** Open items (questions + gaps + homework) over the whole notebook, or over one lecture's pages. */
export function openItems(pages: readonly MapPage[]): number {
	return pages.reduce((n, p) => n + p.open.question + p.open.gap + p.open.homework, 0);
}

/** The map pages of the lecture that contains page `index` (the whole-notebook view narrowed to #223's range). */
export function mapLecture(map: NotebookMap, pages: readonly Page[], index: number): MapPage[] {
	const { from, to } = lectureRange(pages, index);
	return map.pages.slice(from, to);
}

/** Per-page cache: an unchanged page (same revision key) keeps its entry; only the index is refreshed. */
export class NotebookMapCache {
	private readonly entries = new Map<string, { key: string; page: MapPage }>();
	/** Entries computed since the cache was made (for tests: a pointer-cheap rebuild computes none). */
	computed = 0;

	build(pages: readonly Page[], opts: MapOptions = {}): NotebookMap {
		const out: MapPage[] = [];
		const seen = new Set<string>();
		pages.forEach((page, index) => {
			const key = mapKey(page, opts);
			seen.add(page.id);
			let e = this.entries.get(page.id);
			if (!e || e.key !== key) {
				e = { key, page: mapPage(page, index, opts) };
				this.entries.set(page.id, e);
				this.computed++;
			} else if (e.page.index !== index) {
				e = { key, page: { ...e.page, index } };
				this.entries.set(page.id, e);
			}
			out.push(e.page);
		});
		for (const id of [...this.entries.keys()]) if (!seen.has(id)) this.entries.delete(id);
		return { pages: out, counts: countStates(out) };
	}

	clear(): void {
		this.entries.clear();
	}
}
