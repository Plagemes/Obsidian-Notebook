/**
 * 0.13: what Home's Statistics panel and Recent notes list contain, decided from plain data (no 'obsidian', no DOM, no
 * i18n): which widgets exist, which are hidden because they are zero, which become a hint. The view words and draws them.
 */
import type { ActivityRecord } from "./activity-log";
import {
	currentStreak, pagesPerDay, pagesToday, subjectShares, writingMinutes, type DayCount, type SubjectRef, type SubjectShare,
} from "./home-stats";

export interface StatsInput {
	records: readonly ActivityRecord[];
	minutesByDay: Readonly<Record<string, number>>;
	now: number;
	/** The chart's range in days (7 or 14). */
	days: number;
	subjectOf: (path: string) => SubjectRef | null;
	/** Notebooks with PDF pages that were changed in the period. */
	pdfNotebooks: number;
	/** Notebooks in the library (statistics of an empty library are not shown). */
	notebooks: number;
}

export interface StatsModel {
	/** The panel is shown at all (a library with notebooks). */
	visible: boolean;
	days: DayCount[];
	total: number;
	/** Pages a day over the range, one decimal. */
	average: number;
	/** Nothing was written in the range: the chart is replaced by a hint. */
	chartEmpty: boolean;
	/** Days in a row; 0 hides the tile. */
	streak: number;
	/** Estimated minutes of writing in the range; 0 hides the tile. */
	minutes: number;
	/** Pages by subject, most pages first; empty hides the widget. */
	split: SubjectShare[];
	/** PDF notebooks changed in the range; 0 turns the tile into the "Import your first PDF" hint. */
	pdf: number;
}

export function buildStatsModel(i: StatsInput): StatsModel {
	const days = pagesPerDay(i.records, i.now, i.days);
	const total = days.reduce((a, d) => a + d.pages, 0);
	return {
		visible: i.notebooks > 0,
		days,
		total,
		average: Math.round((total / Math.max(1, i.days)) * 10) / 10,
		chartEmpty: total === 0,
		streak: currentStreak(i.records, i.now),
		minutes: writingMinutes(i.minutesByDay, i.now, i.days),
		split: subjectShares(i.records, i.now, i.days, i.subjectOf),
		pdf: i.pdfNotebooks,
	};
}

/** Pages written today, for the greeting (the same count as the last bar of the chart). */
export function todayPages(records: readonly ActivityRecord[], now: number): number {
	return pagesToday(records, now);
}

// ------------------------------------------------------------------ recent notes

/** A page edit as the Recent notes list takes it: from the recent pages log, or a notebook standing in for its first page. */
export interface RecentEdit {
	path: string;
	/** Absent for a notebook standing in for its first page (no log yet). */
	pageId?: string;
	/** 1-based page number (a hint when the page moved). */
	num: number;
	at: number;
}

/** The subjects present in a list of edits (for the filter chips), in the order of their newest edit. */
export function subjectsOfEdits(edits: readonly RecentEdit[], subjectOf: (path: string) => SubjectRef | null): SubjectRef[] {
	const out = new Map<string, SubjectRef>();
	for (const e of [...edits].sort((a, b) => b.at - a.at)) {
		const s = subjectOf(e.path);
		if (s && !out.has(s.key)) out.set(s.key, s);
	}
	return [...out.values()];
}

/** The edits that belong to a subject (`null`: all of them). */
export function filterEdits(edits: readonly RecentEdit[], subject: string | null, subjectOf: (path: string) => SubjectRef | null): RecentEdit[] {
	if (subject === null) return [...edits];
	return edits.filter((e) => subjectOf(e.path)?.key === subject);
}
