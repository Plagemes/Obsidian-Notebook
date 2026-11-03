/**
 * 0.14 (roadmap 415, P1): the library's dynamic sections, decided from plain data. Pure: no 'obsidian', no DOM, no i18n.
 *
 * - Now: the notebook of the class in progress (timetable), the notebooks open in a tab, and the ones edited on this
 *   device in the last few hours.
 * - To complete: notebooks with markers that still ask for something (a gap, an unanswered question, homework not done) or
 *   with pages still to fill (skipped pages, PDF slides without ink, unfinished practice copies).
 * - Changed on another device: notebooks whose file is newer than what this device has seen and was not written here.
 * - Recent is the existing recent log (home-data.ts, the Recent notes list); it is not recomputed here.
 */
import { markAllSeen, seenAt, type SeenState } from "./changed-seen";
import { notebookKey } from "./library-state";

export const DYNAMIC_IDS = ["now", "todo", "changed"] as const;
export type DynamicId = typeof DYNAMIC_IDS[number];

export const HOUR = 60 * 60 * 1000;
/** "Now": notebooks edited on this device within this window. */
export const NOW_WINDOW_MS = 4 * HOUR;
/**
 * A change this close to one of this device's own logged edits is this device's own write. The log time is the last edit,
 * the file is saved a moment later (debounced), so the file time may be a little after.
 */
export const LOCAL_EDIT_SLACK_MS = 30_000;
/** File times of different devices can differ by a little; a change must be later than the seen time by more than this. */
export const CLOCK_TOLERANCE_MS = 2000;

export interface SectionEntry {
	path: string;
	id?: string;
	/** File time (ms). */
	mtime: number;
	/** Document modification time (ms). */
	modified: number;
	openMarkers?: number;
	emptyPages?: number;
}

export interface SectionInput {
	entries: readonly SectionEntry[];
	now: number;
	/** The notebook the class in progress opens (timetable `nowTarget`), when it exists. */
	lecturePath: string | null;
	/** Notebooks open in a tab on this device. */
	openPaths: readonly string[];
	/** This device's page edits (the recent pages log). */
	edits: ReadonlyArray<{ path: string; at: number }>;
	seen: SeenState;
}

export type NowReason = "lecture" | "open" | "edited";

export interface SectionItem {
	path: string;
	/** Why it is here (for the row's second line). */
	reason: NowReason | "markers" | "empty" | "changed";
	/** ms since epoch the row's time refers to. */
	at: number;
	/** Open markers / pages still to fill, for the "To complete" rows. */
	markers?: number;
	empty?: number;
}

export type DynamicSections = Record<DynamicId, SectionItem[]>;

/** Latest logged edit of each notebook path. */
function lastEdits(edits: SectionInput["edits"]): Map<string, number> {
	const out = new Map<string, number>();
	for (const e of edits) if (e.at > (out.get(e.path) ?? 0)) out.set(e.path, e.at);
	return out;
}

/** Whether a file change at `mtime` is explained by one of this device's own edits. */
export function writtenHere(mtime: number, editAt: number | undefined): boolean {
	return editAt !== undefined && editAt >= mtime - LOCAL_EDIT_SLACK_MS;
}

export function notebookSeenKey(e: { id?: string; path: string }): string {
	return notebookKey(e);
}

/** Whether this device has not seen the latest version of a notebook, and did not write it. */
export function isChangedElsewhere(e: SectionEntry, seen: SeenState, editAt: number | undefined): boolean {
	return e.mtime > seenAt(seen, notebookSeenKey(e)) + CLOCK_TOLERANCE_MS && !writtenHere(e.mtime, editAt);
}

export function computeSections(i: SectionInput): DynamicSections {
	const byPath = new Map(i.entries.map((e) => [e.path, e]));
	const edited = lastEdits(i.edits);
	const newest = (a: SectionItem, b: SectionItem) => b.at - a.at;

	const now: SectionItem[] = [];
	const used = new Set<string>();
	if (i.lecturePath && byPath.has(i.lecturePath)) {
		now.push({ path: i.lecturePath, reason: "lecture", at: i.now });
		used.add(i.lecturePath);
	}
	const open: SectionItem[] = [];
	for (const p of i.openPaths) {
		const e = byPath.get(p);
		if (!e || used.has(p)) continue;
		used.add(p);
		open.push({ path: p, reason: "open", at: Math.max(edited.get(p) ?? 0, e.modified) });
	}
	const recent: SectionItem[] = [];
	for (const [p, at] of edited) {
		if (used.has(p) || !byPath.has(p) || i.now - at > NOW_WINDOW_MS || at > i.now + HOUR) continue;
		used.add(p);
		recent.push({ path: p, reason: "edited", at });
	}
	now.push(...open.sort(newest), ...recent.sort(newest));

	const todo: SectionItem[] = [];
	for (const e of i.entries) {
		const markers = e.openMarkers ?? 0;
		const empty = e.emptyPages ?? 0;
		if (markers <= 0 && empty <= 0) continue;
		todo.push({ path: e.path, reason: markers > 0 ? "markers" : "empty", at: e.modified, ...(markers > 0 ? { markers } : {}), ...(empty > 0 ? { empty } : {}) });
	}
	todo.sort(newest);

	const changed: SectionItem[] = [];
	for (const e of i.entries) if (isChangedElsewhere(e, i.seen, edited.get(e.path))) changed.push({ path: e.path, reason: "changed", at: e.mtime });
	changed.sort(newest);

	return { now, todo, changed };
}

/** Marks every notebook of a section as seen (the section's "Mark as seen"); true when the record changed. */
export function markSectionSeen(seen: SeenState, entries: readonly SectionEntry[], items: readonly SectionItem[]): boolean {
	const byPath = new Map(entries.map((e) => [e.path, e]));
	const list: Array<{ key: string; mtime: number }> = [];
	for (const it of items) {
		const e = byPath.get(it.path);
		if (e) list.push({ key: notebookSeenKey(e), mtime: e.mtime });
	}
	return markAllSeen(seen, list);
}
