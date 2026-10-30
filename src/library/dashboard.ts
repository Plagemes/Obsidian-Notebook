/**
 * 0.12 design system: what Home and the library dashboard show, computed locally from the library index (DESIGN.md §5).
 * Subjects, smart collections, frequent tags and statistics. Pure, no 'obsidian'.
 */
import { tagAncestors } from "../model/tags";
import { isInside, normalizeText, type LibraryEntry } from "./index";

const DAY = 24 * 60 * 60 * 1000;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The top-level folder under `root` that holds `path` (a notebook or a folder), or null for something at the root itself. */
export function topFolderOf(path: string, root: string): string | null {
	if (!isInside(path, root) || path === root) return null;
	const rest = root === "" ? path : path.slice(root.length + 1);
	const i = rest.indexOf("/");
	if (i < 0) return null;
	return root === "" ? rest.slice(0, i) : `${root}/${rest.slice(0, i)}`;
}

export interface Subject {
	/** Folder path. */
	path: string;
	name: string;
	notebooks: number;
	pages: number;
	/** Last change of a notebook inside (0 when empty). */
	modified: number;
}

/** One subject per top-level folder under the notebooks root (`folders`: their paths), with recursive counts, by name. */
export function subjectsOf(entries: readonly LibraryEntry[], root: string, folders: readonly string[]): Subject[] {
	const map = new Map<string, Subject>();
	for (const path of folders) {
		if (topFolderOf(`${path}/x`, root) !== path) continue;
		map.set(path, { path, name: path.slice(path.lastIndexOf("/") + 1), notebooks: 0, pages: 0, modified: 0 });
	}
	for (const e of entries) {
		const top = topFolderOf(e.path, root);
		const s = top === null ? undefined : map.get(top);
		if (!s) continue;
		s.notebooks++;
		s.pages += e.pages;
		s.modified = Math.max(s.modified, e.modified);
	}
	return [...map.values()].sort((a, b) => collator.compare(a.name, b.name));
}

/** Smart collections, in display order. */
export const COLLECTIONS = ["study", "favourites", "pdf", "recent", "exams"] as const;
export type CollectionId = typeof COLLECTIONS[number];

/** Tags that mark a notebook to study (any level of a nested tag, accent and case insensitive). */
const STUDY_TAGS = /^(da[-_ ]?studiare|studiare|ripasso|ripassare|to[-_ ]?study|study|review|todo)$/;
/** Tags that mark exam material. */
const EXAM_TAGS = /^(esame|esami|exam|exams|verifica|verifiche|test)$/;
/** "Recent" smart collection: changed in the last week. */
export const RECENT_DAYS = 7;

function hasTag(e: LibraryEntry, re: RegExp): boolean {
	const tags = [...e.tags, ...(e.pageTags ?? []).flatMap((p) => p.tags)];
	return tags.some((t) => [...tagAncestors(t), t].some((x) => re.test(normalizeText(x.split("/").pop() ?? x))));
}

export interface CollectionContext {
	now: number;
	/** Pinned in the library (roadmap 54): pinned notebooks count as favourites too. */
	pinned: (e: LibraryEntry) => boolean;
}

/** Whether a notebook belongs to a smart collection. */
export function inCollection(id: CollectionId, e: LibraryEntry, c: CollectionContext): boolean {
	switch (id) {
		case "study":
			return (e.openMarkers ?? 0) > 0 || hasTag(e, STUDY_TAGS);
		case "favourites":
			return e.favorite || c.pinned(e);
		case "pdf":
			return (e.pdfPages ?? 0) > 0;
		case "recent":
			return e.modified >= c.now - RECENT_DAYS * DAY;
		case "exams":
			return hasTag(e, EXAM_TAGS);
	}
}

/** The smart collections that have content, with their sizes (empty ones are hidden, DESIGN.md §5). */
export function collectionsOf(entries: readonly LibraryEntry[], c: CollectionContext): Array<{ id: CollectionId; count: number }> {
	return COLLECTIONS.map((id) => ({ id, count: entries.filter((e) => inCollection(id, e, c)).length })).filter((x) => x.count > 0);
}

export type KpiId = "created" | "edited" | "pdf" | "tags";

export interface Kpi {
	id: KpiId;
	value: number;
	/** The same measure over the period before, when it can be known exactly; null otherwise (the delta is then not shown). */
	previous: number | null;
	/** Values per bar of the sparkline (days for one week, half weeks for four, weeks for twelve), oldest first. */
	series: number[];
}

/** An edit of a page from the device's recent pages log (library/recent-log.ts). */
export interface EditRecord {
	path: string;
	page: string;
	at: number;
}

/** Periods offered by the statistics dropdown, in weeks. */
export const STAT_PERIODS = [1, 4, 12] as const;
export type StatPeriod = typeof STAT_PERIODS[number];

/** Bars of the sparkline: days for one week, half weeks for four, weeks for twelve. */
function buckets(now: number, weeks: number): { start: number; size: number; count: number } {
	const count = weeks === 1 ? 7 : weeks <= 4 ? weeks * 2 : weeks;
	const size = (weeks * 7 * DAY) / count;
	return { start: now - weeks * 7 * DAY, size, count };
}

/**
 * Statistics over the last `weeks` weeks, all computed on the device:
 * - created: notebooks created (exact, so it has a comparison with the period before);
 * - edited: pages edited on this device (the recent pages log keeps the last edit of each page);
 * - pdf: notebooks with PDF pages changed in the period;
 * - tags: distinct tags of the notebooks changed in the period.
 */
export function statsOf(entries: readonly LibraryEntry[], edits: readonly EditRecord[], now: number, weeks: number): Kpi[] {
	const b = buckets(now, weeks);
	const slot = (t: number) => (t >= b.start && t <= now ? Math.min(b.count - 1, Math.floor((t - b.start) / b.size)) : -1);
	const empty = () => new Array<number>(b.count).fill(0);

	const created = empty();
	let createdBefore = 0;
	for (const e of entries) {
		const i = slot(e.created);
		if (i >= 0) created[i]!++;
		else if (e.created >= b.start - (now - b.start) && e.created < b.start) createdBefore++;
	}

	const edited = empty();
	const seen = new Set<string>();
	for (const x of edits) {
		const key = `${x.path}#${x.page}`;
		const i = slot(x.at);
		if (i < 0 || seen.has(key)) continue;
		seen.add(key);
		edited[i]!++;
	}

	const pdf = empty();
	const tagSets = Array.from({ length: b.count }, () => new Set<string>());
	const allTags = new Set<string>();
	for (const e of entries) {
		const i = slot(e.modified);
		if (i < 0) continue;
		if ((e.pdfPages ?? 0) > 0) pdf[i]!++;
		for (const t of e.tags) {
			const key = normalizeText(t);
			tagSets[i]!.add(key);
			allTags.add(key);
		}
	}

	const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
	return [
		{ id: "created", value: sum(created), previous: createdBefore, series: created },
		{ id: "edited", value: sum(edited), previous: null, series: edited },
		{ id: "pdf", value: sum(pdf), previous: null, series: pdf },
		{ id: "tags", value: allTags.size, previous: null, series: tagSets.map((s) => s.size) },
	];
}

/** Change against the period before, in whole percent; null when there is nothing exact to compare with. */
export function deltaPercent(k: Kpi): number | null {
	if (k.previous === null || k.previous === 0) return null;
	return Math.round(((k.value - k.previous) / k.previous) * 100);
}

function startOfDay(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** "Today, 10:24", "Yesterday, 18:06", "12 Jan, 14:32" (the year too when it is not this year), in the given locale. */
export function stampTime(ms: number, now: number, locale?: string): string {
	const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(ms);
	const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
	if (days === 0 || days === 1) {
		const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-days, "day");
		return `${word.charAt(0).toLocaleUpperCase(locale) + word.slice(1)}, ${time}`;
	}
	const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
	const date = new Intl.DateTimeFormat(locale, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(ms);
	return `${date}, ${time}`;
}
